/***************************************************************************
 * ESB64Native — WHATWG-exact base64 accelerator for the ESB64 library and
 * the ESPACK shared accelerator ("1" in the 1+n model).
 *
 * FREESTANDING build: no CRT, no SDK headers. Imports kernel32 only
 * (CreateFileW/WriteFile/CloseHandle/MultiByteToWideChar/VirtualAlloc/
 * VirtualFree - declared below by hand, the same pattern as the ArcFit
 * freestanding EXEs), own segmented growable arena allocator, own
 * memcpy/memset/strlen. Runs on any Windows x64 (>= Win10 2015; the build
 * targets x86-64-v2, no AVX2/FMA requirement at process startup). This slims
 * the DLL from ~107 KB (default MSVC CRT) to ~10-20 KB.
 *
 * ALLOCATOR (segmented growable arena): segment 0 is a 16 MiB static BSS
 * pool (zeroed, adds nothing to the file size - the common case never
 * touches the OS). Additional segments are VirtualAlloc'd on demand
 * (MEM_RESERVE|MEM_COMMIT, PAGE_READWRITE, rounded to 64 KiB) and
 * VirtualFree'd back to the OS the moment a non-static segment's in-use byte
 * count drops to zero. The host frees returned strings via ESFreeMem (==
 * espk_free) on ITS OWN GC schedule, so in a long-lived session buffers can
 * accumulate far beyond any fixed pool; growth segments make that harmless.
 * ESB64_ERR_NO_MEM (10004) now only fires on a true process-level OOM
 * (VirtualAlloc failure) - never on host buffer accumulation. See the
 * allocator section below for the full design.
 *
 * Build: powershell -ExecutionPolicy Bypass -File build.ps1
 *   (clang+lld with the ArcFit family flags; MSVC fallback - both link
 *   /nodefaultlib /entry:DllMain).
 *
 * Direct-interface ABI (SoSharedLibDefs.h): every method is
 *   long fn(TaggedData* argv, long argc, TaggedData* retval);
 * Returned strings are UTF-8, allocated with espk_malloc, freed by the host
 * via ESFreeMem (== espk_free). Return kESErrOK (0) on success; positive
 * custom codes >= 10000 for catchable errors; negative codes are fatal and
 * never returned.
 *
 * Methods:
 *   b64encode(s) -> base64 string            (WHATWG btoa semantics)
 *   b64decode(s) -> decoded byte string      (WHATWG atob semantics)
 *   b64decodeToFile(b64, path) -> length     (ESPACK extraction fast path:
 *      raw bytes written straight to disk — NUL-safe by construction)
 *
 * Channel constraints (measured on Illustrator 30.6.0): kTypeString returns
 * are C strings — a decoded payload containing NUL (0x00) would be truncated
 * by the host, so b64decode returns kTypeUndefined as a sentinel for
 * NUL-containing outputs (the ESB64 facade falls back to its ES3 lane);
 * b64decodeToFile avoids the channel entirely. Inputs are additionally
 * guaranteed ASCII by the facade, so the UTF-8 boundary is byte-exact.
 *
 * Parity contract: validation and output must EXACTLY match the ESB64 ES3
 * lane (esb64/src/decode.ts decodeFast); the differential corpus runs in
 * both modes.
 ***************************************************************************/

#include <stddef.h>

#include "SoSharedLibDefs.h"

#define ESB64_API __declspec(dllexport)




/* ---- kernel32 imports (declared by hand; no windows.h - freestanding) ---- */

typedef unsigned long DWORD;
typedef int BOOL;
typedef void* HANDLE;
typedef void* LPVOID;
typedef HANDLE HINSTANCE;
typedef wchar_t WCHAR;

#define WINAPI __stdcall
#define TRUE 1
#define FALSE 0

#define INVALID_HANDLE_VALUE ((HANDLE)(long long)-1)
#define CP_UTF8 65001u
#define GENERIC_WRITE 0x40000000u
#define CREATE_ALWAYS 2u
#define FILE_ATTRIBUTE_NORMAL 0x80u

__declspec(dllimport) int __stdcall MultiByteToWideChar(
    unsigned int CodePage, DWORD dwFlags, const char* lpMultiByteStr,
    int cbMultiByte, wchar_t* lpWideCharStr, int cchWideChar);
__declspec(dllimport) HANDLE __stdcall CreateFileW(
    const wchar_t* lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode,
    LPVOID lpSecurityAttributes, DWORD dwCreationDisposition,
    DWORD dwFlagsAndAttributes, HANDLE hTemplateFile);
__declspec(dllimport) BOOL __stdcall WriteFile(
    HANDLE hFile, const void* lpBuffer, DWORD nNumberOfBytesToWrite,
    DWORD* lpNumberOfBytesWritten, LPVOID lpOverlapped);
__declspec(dllimport) BOOL __stdcall CloseHandle(HANDLE hObject);
__declspec(dllimport) LPVOID __stdcall VirtualAlloc(
    LPVOID lpAddress, size_t dwSize, DWORD flAllocationType, DWORD flProtect);
__declspec(dllimport) BOOL __stdcall VirtualFree(
    LPVOID lpAddress, size_t dwSize, DWORD dwFreeType);

/* VirtualAlloc/VirtualFree flags (freestanding - no windows.h) */
#define MEM_COMMIT 0x1000u
#define MEM_RESERVE 0x2000u
#define MEM_RELEASE 0x8000u
#define PAGE_READWRITE 0x04u

/* catchable custom error codes (>= 10000, ThioUtils convention) */
#define ESB64_ERR_B64_INVALID 10001 /* atob: malformed input */
#define ESB64_ERR_B64_LATIN1  10002 /* btoa: non-Latin1 input */
#define ESB64_ERR_FILE_WRITE  10003 /* b64decodeToFile: cannot write the target */
#define ESB64_ERR_NO_MEM      10004 /* allocator failure (true OOM only:
                                       VirtualAlloc growth failed - the
                                       segmented arena has no fixed cap, so
                                       host buffer accumulation can no
                                       longer exhaust it; positive code:
                                       negative codes are fatal/uncatchable) */

/* ---- freestanding libc substitutes ---------------------------------------- */

static void* memcpy(void* dst, const void* src, size_t n)
{
    unsigned char* d = (unsigned char*)dst;
    const unsigned char* s = (const unsigned char*)src;
    while (n--) {
        *d++ = *s++;
    }
    return dst;
}

static void* memset(void* dst, int c, size_t n)
{
    unsigned char* d = (unsigned char*)dst;
    while (n--) {
        *d++ = (unsigned char)c;
    }
    return dst;
}

static size_t strlen(const char* s)
{
    const char* p = s;
    while (*p) {
        p++;
    }
    return (size_t)(p - s);
}

/*
 * Segmented growable arena (v2 allocator). Root cause this fixes: the host
 * frees returned kTypeString buffers via ESFreeMem on ITS OWN GC schedule,
 * so in a long-lived session the OLD fixed-pool first-fit allocator drained
 * its 16 MiB BSS pool and espk_malloc returned NULL -> ESB64_ERR_NO_MEM.
 *
 * Design:
 *   - Segment 0 is the existing static BSS pool (16 MiB, zero-initialized,
 *     no file footprint, no OS dependency - the common case never calls
 *     VirtualAlloc). It is never released.
 *   - Additional segments are VirtualAlloc'd on demand (MEM_RESERVE|
 *     MEM_COMMIT, PAGE_READWRITE) and each embeds its EspkSeg bookkeeping
 *     struct at the start of its region. Size = max(ESPK_GROW_SIZE, need +
 *     struct), rounded up to 64 KiB. There is NO cap on segment count - the
 *     arena grows as long as the process has address space.
 *   - espk_malloc order: (a) first-fit over the free list, (b) bump-allocate
 *     from the segment list (static/earlier segments first), (c) grow a new
 *     segment via VirtualAlloc. VirtualAlloc failure returns NULL -> 10004
 *     (now only on true process OOM, never host accumulation).
 *   - espk_free: validates the pointer belongs to a segment (8-aligned
 *     relative to the segment base), ignores foreign pointers and
 *     double-frees exactly as before, then inserts the block into the free
 *     list in ADDRESS ORDER, coalescing with adjacent free blocks ONLY when
 *     the neighbor is in the SAME segment (VirtualAlloc regions can be
 *     adjacent across allocations).
 *   - Per-segment in_use byte counter: +need on alloc, -h->size on free.
 *     When a non-static segment's in_use hits 0, all its free-list blocks
 *     are unlinked and the region is VirtualFree'd (MEM_RELEASE) - RSS
 *     returns to the baseline when the host GC frees everything.
 *   - Blocks are not split on reuse (remainder lost), matching prior
 *     behavior and keeping the in_use accounting exact.
 */
#define ESPK_POOL_SIZE (16u << 20)
#define ESPK_GROW_SIZE (32u << 20)
#define ESPK_ALIGN 8u
#define ESPK_SEG_MASK 0xFFFFu /* VirtualAlloc regions round up to 64 KiB */

/* ESPK_TEST_MAIN (stress hook at the bottom of this file) needs the
   allocator functions reachable from main(); the DLL build keeps them
   static. */
#ifdef ESPK_TEST_MAIN
#define ESPK_STATIC
#else
#define ESPK_STATIC static
#endif

typedef struct EspkHdr {
    size_t size;
    void* next;
} EspkHdr;

/* Per-segment bookkeeping. Growth segments embed their struct at the very
   start of the VirtualAlloc'd region (never handed out; the region dies with
   the segment, so the struct needs no separate storage or release). */
typedef struct EspkSeg {
    struct EspkSeg* next; /* next segment in the list (NULL for last) */
    unsigned char* base;  /* first byte of the user region (8-aligned) */
    size_t cap;           /* usable capacity of the user region */
    size_t bump;          /* bump cursor: next free offset within [0, cap) */
    size_t in_use;        /* bytes currently handed out to callers */
    int is_static;        /* nonzero for the BSS segment (never released) */
} EspkSeg;

#define SEGSTRUCT_ROUND ((sizeof(EspkSeg) + ESPK_ALIGN - 1) & \
                         ~(size_t)(ESPK_ALIGN - 1))

static union {
    unsigned char b[ESPK_POOL_SIZE];
    double align; /* 8-aligned pool base */
} g_pool_u;
#define g_pool (g_pool_u.b)
static EspkSeg g_seg0 = { NULL, g_pool, ESPK_POOL_SIZE, 0, 0, 1 };
static void* g_free = NULL;

/* is hdr inside seg's user region? (block headers live in [base, base+cap)) */
ESPK_STATIC int espk_seg_contains(EspkSeg* seg, const unsigned char* hdr)
{
    return hdr >= seg->base && hdr < seg->base + seg->cap;
}

/* segment owning a block HEADER address (free-list nodes), or NULL */
ESPK_STATIC EspkSeg* espk_seg_of_block(const unsigned char* hdr)
{
    EspkSeg* s;
    for (s = &g_seg0; s != NULL; s = s->next) {
        if (espk_seg_contains(s, hdr)) {
            return s;
        }
    }
    return NULL;
}

/* segment owning a USER pointer. A valid block start is at least
   sizeof(EspkHdr) into a segment and 8-aligned relative to its base; any
   other pointer (foreign, misaligned, inside a header) is not one of ours. */
ESPK_STATIC EspkSeg* espk_find_segment(const unsigned char* p)
{
    EspkSeg* s;
    for (s = &g_seg0; s != NULL; s = s->next) {
        if (p >= s->base && p < s->base + s->cap) {
            if (p >= s->base + sizeof(EspkHdr) &&
                ((size_t)(p - s->base) & (ESPK_ALIGN - 1)) == 0) {
                return s;
            }
            return NULL; /* inside a segment but not a valid block start */
        }
    }
    return NULL;
}

/* VirtualAlloc a new growth segment big enough for `need`, append it to the
   segment list, and return it; NULL on VirtualAlloc failure (true OOM). */
ESPK_STATIC EspkSeg* espk_grow_segment(size_t need)
{
    size_t rsize = need + SEGSTRUCT_ROUND;
    unsigned char* region;
    EspkSeg* s;
    EspkSeg* tail;
    if (rsize < ESPK_GROW_SIZE) {
        rsize = ESPK_GROW_SIZE;
    }
    rsize = (rsize + ESPK_SEG_MASK) & ~(size_t)ESPK_SEG_MASK;
    region = (unsigned char*)VirtualAlloc(NULL, rsize,
                                          MEM_COMMIT | MEM_RESERVE,
                                          PAGE_READWRITE);
    if (region == NULL) {
        return NULL;
    }
    s = (EspkSeg*)region;
    s->next = NULL;
    s->base = region + SEGSTRUCT_ROUND;
    s->cap = rsize - SEGSTRUCT_ROUND;
    s->bump = 0;
    s->in_use = 0;
    s->is_static = 0;
    for (tail = &g_seg0; tail->next != NULL; tail = tail->next) {
    }
    tail->next = s;
    return s;
}

/* Return a fully-free non-static segment to the OS: unlink every free-list
   block inside it (seg->in_use == 0 here, so no live blocks remain), unlink
   the segment, then VirtualFree the region (which also discards the embedded
   struct). */
ESPK_STATIC void espk_release_segment(EspkSeg* seg)
{
    EspkSeg* prev;
    EspkHdr** pp = (EspkHdr**)&g_free;
    EspkHdr* h;
    while (*pp != NULL) {
        h = (EspkHdr*)*pp;
        if (espk_seg_contains(seg, (unsigned char*)h)) {
            *pp = h->next;
        }
        else {
            pp = (EspkHdr**)&h->next;
        }
    }
    prev = &g_seg0;
    while (prev->next != NULL && prev->next != seg) {
        prev = prev->next;
    }
    if (prev->next == seg) {
        prev->next = seg->next;
    }
    VirtualFree(seg, 0, MEM_RELEASE);
}

/* allocator introspection (used by the ESPK_TEST_MAIN stress hook) */
ESPK_STATIC size_t espk_segment_count(void)
{
    size_t n = 0;
    EspkSeg* s;
    for (s = &g_seg0; s != NULL; s = s->next) {
        n++;
    }
    return n;
}

ESPK_STATIC size_t espk_total_capacity(void)
{
    size_t tot = 0;
    EspkSeg* s;
    for (s = &g_seg0; s != NULL; s = s->next) {
        tot += s->cap;
    }
    return tot;
}

ESPK_STATIC void* espk_malloc(size_t n)
{
    size_t need = (n + sizeof(EspkHdr) + ESPK_ALIGN - 1) &
                  ~(size_t)(ESPK_ALIGN - 1);
    EspkHdr* h;
    EspkHdr** pp;
    EspkSeg* s;
    if (need == 0) {
        need = sizeof(EspkHdr) + ESPK_ALIGN;
    }
    /* (a) first-fit over the free list */
    pp = (EspkHdr**)&g_free;
    while (*pp != NULL) {
        h = (EspkHdr*)*pp;
        if (h->size >= need) {
            *pp = h->next;
            h->size = need;
            s = espk_seg_of_block((unsigned char*)h);
            s->in_use += need;
            return (void*)((unsigned char*)h + sizeof(EspkHdr));
        }
        pp = (EspkHdr**)&h->next;
    }
    /* (b) bump-allocate from segments (static/earlier segments first) */
    for (s = &g_seg0; s != NULL; s = s->next) {
        if (s->bump + need <= s->cap) {
            h = (EspkHdr*)(s->base + s->bump);
            s->bump += need;
            h->size = need;
            h->next = NULL;
            s->in_use += need;
            return (void*)((unsigned char*)h + sizeof(EspkHdr));
        }
    }
    /* (c) grow: VirtualAlloc a new segment (failure = true OOM -> 10004) */
    s = espk_grow_segment(need);
    if (s == NULL) {
        return NULL;
    }
    h = (EspkHdr*)(s->base + s->bump);
    s->bump += need;
    h->size = need;
    h->next = NULL;
    s->in_use += need;
    return (void*)((unsigned char*)h + sizeof(EspkHdr));
}

ESPK_STATIC void espk_free(void* p)
{
    unsigned char* base;
    EspkHdr* h;
    EspkHdr* it;
    EspkHdr* pred;
    EspkHdr* succ;
    EspkHdr** pp;
    EspkSeg* seg;
    if (p == NULL) {
        return;
    }
    base = (unsigned char*)p;
    /* Guards against host-side misuse of ESFreeMem (verified crash cause:
       an access violation in ntdll heap code when the host freed a pointer
       that is not one of ours - e.g. the static ESInitialize signature
       literal - or freed the same block twice). Anything outside every
       segment, misaligned, or already on the free list is ignored. */
    seg = espk_find_segment(base);
    if (seg == NULL) {
        return; /* foreign pointer */
    }
    h = (EspkHdr*)(base - sizeof(EspkHdr));
    it = (EspkHdr*)g_free;
    while (it != NULL) {
        if ((void*)it == (void*)h) {
            return; /* double free */
        }
        it = (EspkHdr*)it->next;
    }
    seg->in_use -= h->size;
    /* address-ordered insert (pointer order via integer casts - regions from
       separate VirtualAlloc calls are unrelated objects) */
    pred = NULL;
    pp = (EspkHdr**)&g_free;
    while (*pp != NULL &&
           (unsigned long long)*pp < (unsigned long long)h) {
        pred = (EspkHdr*)*pp;
        pp = (EspkHdr**)&pred->next;
    }
    succ = (EspkHdr*)*pp;
    h->next = succ;
    *pp = h;
    /* coalesce with a same-segment predecessor ending exactly at h. h->size
       already includes the header (need rounds up n + sizeof(EspkHdr)), so
       the next block's header sits exactly at hdr + size - no extra gap. */
    if (pred != NULL &&
        (unsigned char*)pred + pred->size == (unsigned char*)h &&
        espk_seg_contains(seg, (unsigned char*)pred)) {
        pred->size += h->size;
        pred->next = h->next;
        h = pred;
    }
    /* coalesce with a same-segment successor starting exactly at h's end */
    if (h->next != NULL &&
        (unsigned char*)h + h->size == (unsigned char*)h->next &&
        espk_seg_contains(seg, (unsigned char*)h->next)) {
        EspkHdr* b = (EspkHdr*)h->next;
        h->size += b->size;
        h->next = b->next;
    }
    if (seg->in_use == 0 && !seg->is_static) {
        espk_release_segment(seg);
    }
}

/* ---- mandatory entry points ---- */

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved)
{
    (void)hinst;
    (void)reason;
    (void)reserved;
    return TRUE;
}

ESB64_API char* ESInitialize(TaggedData* argv, long argc)
{
    (void)argv;
    (void)argc;
    return "b64encode_s,b64decode_s,b64decodeToFile_ss";
}

ESB64_API long ESGetVersion(void)
{
    return 1;
}

ESB64_API void ESFreeMem(void* p)
{
    espk_free(p);
}

ESB64_API void ESTerminate(void)
{
}

/* ---- helpers ---- */

static char* dup_bytes(const unsigned char* p, size_t n)
{
    char* b = (char*)espk_malloc(n + 1);
    if (b != NULL) {
        memcpy(b, p, n);
        b[n] = '\0';
    }
    return b;
}

static const char b64_alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* ---- branchless character classification table (bit-level) ----------------
 * T[c]: alphabet value 0-63, whitespace -2, '=' -3, anything else -1.
 * Invalid detection in the decode is branchless per quad: every valid value
 * is 0x00-0x3F, so `(v & 0x80) != 0` identifies -1/-2/-3 in one mask op
 * over the OR of a quad's values. */
static signed char T[256];
static int T_init = 0;

static void init_T(void)
{
    int i;
    for (i = 0; i < 256; i++) {
        T[i] = -1;
    }
    for (i = 0; i < 64; i++) {
        T[(unsigned char)b64_alphabet[i]] = (signed char)i;
    }
    T[(int)'='] = -3;
    T[(int)' '] = -2;
    T[(int)'\t'] = -2;
    T[(int)'\n'] = -2;
    T[(int)'\f'] = -2;
    T[(int)'\r'] = -2;
    T_init = 1;
}

#define IS_BAD(v) (((v) & 0x80) != 0)

/* Word-at-a-time helpers (Bit Twiddling Hacks hasless/haszero, scalar SWAR).
   Unaligned 8-byte loads via memcpy (compiled to a single mov on x64). */
#define ESPK_ONES 0x0101010101010101ull
#define ESPK_HIGH 0x8080808080808080ull

static unsigned long long espk_hasless(unsigned long long x, unsigned long long n)
{
    return (x - n * ESPK_ONES) & ~x & ESPK_HIGH;
}

/* First ASCII-whitespace index in s[0..n), or n when none.
   The whitespace set is {0x09..0x0D, 0x20}: per byte, 9 <= c <= 13 via
   hasless(c,14) & ~hasless(c,9), plus c == 32 via haszero(c ^ 0x20). */
static size_t espk_ws_scan(const unsigned char* s, size_t n)
{
    size_t i = 0;
    if (n >= 8) {
        for (; i + 8 <= n; i += 8) {
            unsigned long long x;
            unsigned long long ws;
            int k;
            memcpy(&x, s + i, 8);
            ws = (espk_hasless(x, 14) & ~espk_hasless(x, 9)) |
                 (espk_hasless(x ^ 0x2020202020202020ull, 1));
            if (ws) {
                /* rare: locate the byte (no ctz intrinsic needed) */
                for (k = 0; k < 8; k++) {
                    unsigned char c = s[i + k];
                    if ((c >= 9 && c <= 13) || c == 32) {
                        return i + (size_t)k;
                    }
                }
            }
        }
    }
    for (; i < n; i++) {
        unsigned char c = s[i];
        if ((c >= 9 && c <= 13) || c == 32) {
            return i;
        }
    }
    return n;
}

/*
 * WHATWG forgiving-base64 decode with EXACTLY the ESB64 ES3 lane's
 * validation (esb64/src/decode.ts decodeFast):
 *   1. strip ASCII whitespace [ \t\n\f\r]
 *   2. (n & 3) === 1                     -> invalid
 *   3. /^[A-Za-z0-9+\/]*={0,2}$/         -> invalid (charset; '=' only
 *      trailing, max 2)
 *   4. n >= 1 && last == '=' && (n & 3) != 0 -> invalid
 *   5. strip = trailing '=' count (1 or 2) when (n & 3) === 0
 *   6. body = n - strip; (body & 3) === 1 -> invalid
 *   7. decode body (full quads + rem 2/3 tail), exactly byte-for-byte.
 *
 * Performance shape (measured-optimal patterns from the ES3 lane): ONE
 * buffer (n+1) serves as both the whitespace-compacted source and the
 * decode output (the output index never overtakes the read index), a single
 * early-exit whitespace scan skips the compaction pass for whitespace-free
 * inputs (the common case), the main loop decodes 8 quads (32 chars) per
 * iteration with 32 independent table loads (ILP) and ONE branchless
 * invalid-mask check per batch, and the per-quad byte math is the minimal
 * shift form. The pre-validation charset pass is provably redundant: every
 * body position is read by the decode, which validates in-loop.
 *
 * Returns 0 (ESB64_ERR_B64_INVALID on validation failure). On success
 * *outp is the (single) malloc'd buffer holding the RAW decoded bytes
 * (NUL-capable; the transport layer decides how to hand them to the host),
 * *outlenp the decoded byte count.
 */
static long b64_decode_raw(const char* in, size_t n, unsigned char** outp,
                           size_t* outlenp)
{
    unsigned char* buf;
    const unsigned char* src;
    size_t sn = 0, i, o = 0, eq = 0, body, strip = 0;
    size_t ws_at;
if (!T_init) {
        init_T();
        T_init = 1;
    }

    /* word-at-a-time whitespace scan (common case: none -> no compaction) */
        ws_at = espk_ws_scan((const unsigned char*)in, n);
        
    buf = (unsigned char*)espk_malloc(n + 1);
    if (buf == NULL) {
        return ESB64_ERR_NO_MEM;
    }
    if (ws_at < n) {
        for (i = 0; i < n; i++) {
            if (T[(unsigned char)in[i]] != -2) {
                buf[sn++] = (unsigned char)in[i];
            }
        }
        src = buf;
    } else {
        sn = n;
        src = (const unsigned char*)in;
    }

    if ((sn & 3) == 1) { /* length mod 4 == 1 */
        espk_free(buf);
        return ESB64_ERR_B64_INVALID;
    }
    /* trailing '=' run */
    while (eq < sn && src[sn - 1 - eq] == '=') {
        eq++;
    }
    if (eq > 2) {
        espk_free(buf);
        return ESB64_ERR_B64_INVALID;
    }
    if (sn >= 1 && eq > 0 && (sn & 3) != 0) { /* '=' on non-quad boundary */
        espk_free(buf);
        return ESB64_ERR_B64_INVALID;
    }
    if ((sn & 3) == 0 && eq > 0) {
        strip = eq; /* 1 or 2 */
    }
    body = sn - strip;
    if ((body & 3) == 1) {
        espk_free(buf);
        return ESB64_ERR_B64_INVALID;
    }

    /* main loop: 8 quads (32 chars) -> 24 bytes per iteration. All loads
       are hoisted before the stores, so the in-place write (o < i always:
       3 bytes out per 4 chars in) can never clobber unread input. */
    i = 0;
    while (i + 31 < body) {
        int a0 = T[src[i]], b0 = T[src[i + 1]], c0 = T[src[i + 2]], d0 = T[src[i + 3]];
        int a1 = T[src[i + 4]], b1 = T[src[i + 5]], c1 = T[src[i + 6]], d1 = T[src[i + 7]];
        int a2 = T[src[i + 8]], b2 = T[src[i + 9]], c2 = T[src[i + 10]], d2 = T[src[i + 11]];
        int a3 = T[src[i + 12]], b3 = T[src[i + 13]], c3 = T[src[i + 14]], d3 = T[src[i + 15]];
        int a4 = T[src[i + 16]], b4 = T[src[i + 17]], c4 = T[src[i + 18]], d4 = T[src[i + 19]];
        int a5 = T[src[i + 20]], b5 = T[src[i + 21]], c5 = T[src[i + 22]], d5 = T[src[i + 23]];
        int a6 = T[src[i + 24]], b6 = T[src[i + 25]], c6 = T[src[i + 26]], d6 = T[src[i + 27]];
        int a7 = T[src[i + 28]], b7 = T[src[i + 29]], c7 = T[src[i + 30]], d7 = T[src[i + 31]];
        if (IS_BAD(a0 | b0 | c0 | d0 | a1 | b1 | c1 | d1 |
                   a2 | b2 | c2 | d2 | a3 | b3 | c3 | d3 |
                   a4 | b4 | c4 | d4 | a5 | b5 | c5 | d5 |
                   a6 | b6 | c6 | d6 | a7 | b7 | c7 | d7)) {
            espk_free(buf);
            return ESB64_ERR_B64_INVALID;
        }
        buf[o] = (unsigned char)((a0 << 2) | (b0 >> 4));
        buf[o + 1] = (unsigned char)(((b0 & 15) << 4) | (c0 >> 2));
        buf[o + 2] = (unsigned char)(((c0 & 3) << 6) | d0);
        buf[o + 3] = (unsigned char)((a1 << 2) | (b1 >> 4));
        buf[o + 4] = (unsigned char)(((b1 & 15) << 4) | (c1 >> 2));
        buf[o + 5] = (unsigned char)(((c1 & 3) << 6) | d1);
        buf[o + 6] = (unsigned char)((a2 << 2) | (b2 >> 4));
        buf[o + 7] = (unsigned char)(((b2 & 15) << 4) | (c2 >> 2));
        buf[o + 8] = (unsigned char)(((c2 & 3) << 6) | d2);
        buf[o + 9] = (unsigned char)((a3 << 2) | (b3 >> 4));
        buf[o + 10] = (unsigned char)(((b3 & 15) << 4) | (c3 >> 2));
        buf[o + 11] = (unsigned char)(((c3 & 3) << 6) | d3);
        buf[o + 12] = (unsigned char)((a4 << 2) | (b4 >> 4));
        buf[o + 13] = (unsigned char)(((b4 & 15) << 4) | (c4 >> 2));
        buf[o + 14] = (unsigned char)(((c4 & 3) << 6) | d4);
        buf[o + 15] = (unsigned char)((a5 << 2) | (b5 >> 4));
        buf[o + 16] = (unsigned char)(((b5 & 15) << 4) | (c5 >> 2));
        buf[o + 17] = (unsigned char)(((c5 & 3) << 6) | d5);
        buf[o + 18] = (unsigned char)((a6 << 2) | (b6 >> 4));
        buf[o + 19] = (unsigned char)(((b6 & 15) << 4) | (c6 >> 2));
        buf[o + 20] = (unsigned char)(((c6 & 3) << 6) | d6);
        buf[o + 21] = (unsigned char)((a7 << 2) | (b7 >> 4));
        buf[o + 22] = (unsigned char)(((b7 & 15) << 4) | (c7 >> 2));
        buf[o + 23] = (unsigned char)(((c7 & 3) << 6) | d7);
        o += 24;
        i += 32;
    }
    while (i + 3 < body) {
        int a = T[src[i]], b = T[src[i + 1]], c = T[src[i + 2]], d = T[src[i + 3]];
        if (IS_BAD(a | b | c | d)) {
            espk_free(buf);
            return ESB64_ERR_B64_INVALID;
        }
        buf[o++] = (unsigned char)((a << 2) | (b >> 4));
        buf[o++] = (unsigned char)(((b & 15) << 4) | (c >> 2));
        buf[o++] = (unsigned char)(((c & 3) << 6) | d);
        i += 4;
    }
    {
        size_t rem = body - i;
        if (rem == 2) {
            int a = T[src[i]], b = T[src[i + 1]];
            if (IS_BAD(a | b)) {
                espk_free(buf);
                return ESB64_ERR_B64_INVALID;
            }
            buf[o++] = (unsigned char)((a << 2) | (b >> 4));
        }
        else if (rem == 3) {
            int a = T[src[i]], b = T[src[i + 1]], c = T[src[i + 2]];
            if (IS_BAD(a | b | c)) {
                espk_free(buf);
                return ESB64_ERR_B64_INVALID;
            }
            buf[o++] = (unsigned char)((a << 2) | (b >> 4));
            buf[o++] = (unsigned char)(((b & 15) << 4) | (c >> 2));
        }
    }
    *outlenp = o;
    *outp = buf;
    return kESErrOK;
}

/* kTypeString-return transport: single pass over the decoded bytes that
   tracks NULs AND UTF-8-encodes them (the common NUL-free case pays one
   pass instead of two); NUL outputs -> kTypeUndefined sentinel (the ESB64
   facade falls back to the ES3 lane). */
static long b64_decode_whatwg(const char* in, size_t n, char** outp,
                              size_t* outlenp, int* has_nul)
{
    unsigned char* raw = NULL;
    size_t o = 0;
    size_t i;
    size_t nul_count = 0;
    long rc = b64_decode_raw(in, n, &raw, &o);
        char* utf8;
    if (rc != kESErrOK) {
        return rc;
    }
    utf8 = (char*)espk_malloc(o * 2 + 1);
    if (utf8 == NULL) {
        espk_free(raw);
        return ESB64_ERR_NO_MEM;
    }
    {
        size_t u = 0;
        i = 0;
        /* word fast path: all-ASCII words copy 8 bytes and count NULs with
           one haszero mask; mixed/high words fall to the slow loop */
        while (i + 8 <= o) {
            unsigned long long x;
            unsigned long long z;
            memcpy(&x, raw + i, 8);
            if (x & ESPK_HIGH) {
                break;
            }
            z = espk_hasless(x, 1);
            if (z) {
                int k2;
                for (k2 = 0; k2 < 8; k2++) {
                    if (raw[i + k2] == 0) {
                        nul_count++;
                    }
                }
            }
            memcpy(utf8 + u, raw + i, 8);
            u += 8;
            i += 8;
        }
        for (; i < o; i++) {
            unsigned char c = raw[i];
            if (c == 0) {
                nul_count++;
            }
            if (c < 0x80) {
                utf8[u++] = (char)c;
            }
            else if (c < 0xC0) {
                utf8[u++] = (char)(0xC2 | (c >> 6));
                utf8[u++] = (char)(0x80 | (c & 0x3F));
            }
            else {
                utf8[u++] = (char)(0xC3 | (c >> 6));
                utf8[u++] = (char)(0x80 | (c & 0x3F));
            }
        }
        utf8[u] = '\0';
    }
    espk_free(raw);
    if (nul_count) {
        espk_free(utf8);
        *has_nul = 1;
        *outp = NULL;
        return kESErrOK;
    }
    *has_nul = 0;
    *outlenp = o;
    *outp = utf8;
    return kESErrOK;
}

/* b64decode(s) -> decoded string, or undefined when the output contains NUL. */
ESB64_API long b64decode(TaggedData* argv, long argc, TaggedData* retval)
{
    long rc;
    char* out = NULL;
    size_t outlen = 0;
    int has_nul = 0;
        if (argc != 1 || argv[0].type != kTypeString) {
        return kESErrBadArgumentList;
    }
    rc = b64_decode_whatwg(argv[0].data.string, strlen(argv[0].data.string),
                           &out, &outlen, &has_nul);
    if (rc != kESErrOK) {
        return rc;
    }
    if (has_nul) {
        retval->type = kTypeUndefined; /* sentinel: facade falls back to ES3 */
        return kESErrOK;
    }
    retval->type = kTypeString;
    retval->data.string = out;
    return kESErrOK;
}

/*
 * b64decodeToFile(b64, outPath) -> decoded length (kTypeInteger).
 * The ESPACK extraction fast path: decodes WHATWG-exactly and writes the
 * RAW bytes directly to outPath via CreateFileW/WriteFile (kernel32, no
 * CRT) - no string channel, NUL-safe by construction. The caller (espack
 * loader) verifies the returned length against the expected payload size
 * and falls back to the JSX lane on any error code.
 * Errors: 10001 invalid base64, 10003 cannot write the target file.
 */
ESB64_API long b64decodeToFile(TaggedData* argv, long argc, TaggedData* retval)
{
    unsigned char* out = NULL;
    size_t outlen = 0;
    long rc;
    wchar_t* wpath;
    int wlen;
    HANDLE h;
    DWORD written = 0;
    BOOL ok;
    if (argc != 2 || argv[0].type != kTypeString || argv[1].type != kTypeString) {
        return kESErrBadArgumentList;
    }
    rc = b64_decode_raw(argv[0].data.string, strlen(argv[0].data.string),
                        &out, &outlen);
    if (rc != kESErrOK) {
        return rc;
    }
    wlen = MultiByteToWideChar(CP_UTF8, 0, argv[1].data.string, -1, NULL, 0);
    if (wlen <= 0) {
        espk_free(out);
        return ESB64_ERR_FILE_WRITE;
    }
    wpath = (wchar_t*)espk_malloc((size_t)wlen * sizeof(wchar_t));
    if (wpath == NULL) {
        espk_free(out);
        return ESB64_ERR_NO_MEM;
    }
    MultiByteToWideChar(CP_UTF8, 0, argv[1].data.string, -1, wpath, wlen);
    h = CreateFileW(wpath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL, NULL);
    espk_free(wpath);
    if (h == INVALID_HANDLE_VALUE) {
        espk_free(out);
        return ESB64_ERR_FILE_WRITE;
    }
    ok = WriteFile(h, out, (DWORD)outlen, &written, NULL);
    CloseHandle(h);
    espk_free(out);
    if (!ok || (size_t)written != outlen) {
        return ESB64_ERR_FILE_WRITE;
    }
    retval->type = kTypeInteger;
    retval->data.intval = (long)outlen;
    return kESErrOK;
}

/*
 * WHATWG btoa encode. The input arrives as UTF-8 of code units the facade
 * has guaranteed to be Latin1 and NUL-free, so each unit is either one byte
 * (0x01-0x7F) or a two-byte UTF-8 pair (0xC2/0xC3 + 0x80-0xBF). Recover the
 * units, then base64-encode with padding.
 */
static long b64_encode_whatwg(const char* in, size_t n, char** outp)
{
    unsigned char* units;
    size_t un = 0, i, o = 0;
    char* out;
    units = (unsigned char*)espk_malloc(n + 1);
    if (units == NULL) {
        return ESB64_ERR_NO_MEM;
    }
        i = 0;
    /* word-at-a-time ASCII fast path: 8 units per iteration when the input
       word has no high bytes (the facade guarantees Latin1, so high bytes
       only appear as 2-byte UTF-8 pairs handled by the slow loop). */
    while (i + 8 <= n) {
        unsigned long long x;
        memcpy(&x, in + i, 8);
        if (x & ESPK_HIGH) {
            break;
        }
        units[un] = (unsigned char)in[i];
        units[un + 1] = (unsigned char)in[i + 1];
        units[un + 2] = (unsigned char)in[i + 2];
        units[un + 3] = (unsigned char)in[i + 3];
        units[un + 4] = (unsigned char)in[i + 4];
        units[un + 5] = (unsigned char)in[i + 5];
        units[un + 6] = (unsigned char)in[i + 6];
        units[un + 7] = (unsigned char)in[i + 7];
        un += 8;
        i += 8;
    }
    while (i < n) {
        unsigned char c = (unsigned char)in[i];
        if (c < 0x80) {
            units[un++] = c;
            i += 1;
        }
        else if ((c == 0xC2 || c == 0xC3) && i + 1 < n &&
                 (unsigned char)in[i + 1] >= 0x80 &&
                 (unsigned char)in[i + 1] <= 0xBF) {
            units[un++] = (unsigned char)(((c & 0x1F) << 6) |
                                          ((unsigned char)in[i + 1] & 0x3F));
            i += 2;
        }
        else {
            espk_free(units);
            return ESB64_ERR_B64_LATIN1; /* not Latin1 (cannot reach via facade) */
        }
    }
    out = (char*)espk_malloc(((un + 2) / 3) * 4 + 1);
    if (out == NULL) {
        espk_free(units);
        return ESB64_ERR_NO_MEM;
    }
    /* encode 4 groups (12 units) per iteration: 4 independent value chains */
    i = 0;
    while (i + 11 < un) {
        unsigned long v0 = ((unsigned long)units[i] << 16) |
                           ((unsigned long)units[i + 1] << 8) | units[i + 2];
        unsigned long v1 = ((unsigned long)units[i + 3] << 16) |
                           ((unsigned long)units[i + 4] << 8) | units[i + 5];
        unsigned long v2 = ((unsigned long)units[i + 6] << 16) |
                           ((unsigned long)units[i + 7] << 8) | units[i + 8];
        unsigned long v3 = ((unsigned long)units[i + 9] << 16) |
                           ((unsigned long)units[i + 10] << 8) | units[i + 11];
        out[o] = b64_alphabet[(v0 >> 18) & 63];
        out[o + 1] = b64_alphabet[(v0 >> 12) & 63];
        out[o + 2] = b64_alphabet[(v0 >> 6) & 63];
        out[o + 3] = b64_alphabet[v0 & 63];
        out[o + 4] = b64_alphabet[(v1 >> 18) & 63];
        out[o + 5] = b64_alphabet[(v1 >> 12) & 63];
        out[o + 6] = b64_alphabet[(v1 >> 6) & 63];
        out[o + 7] = b64_alphabet[v1 & 63];
        out[o + 8] = b64_alphabet[(v2 >> 18) & 63];
        out[o + 9] = b64_alphabet[(v2 >> 12) & 63];
        out[o + 10] = b64_alphabet[(v2 >> 6) & 63];
        out[o + 11] = b64_alphabet[v2 & 63];
        out[o + 12] = b64_alphabet[(v3 >> 18) & 63];
        out[o + 13] = b64_alphabet[(v3 >> 12) & 63];
        out[o + 14] = b64_alphabet[(v3 >> 6) & 63];
        out[o + 15] = b64_alphabet[v3 & 63];
        o += 16;
        i += 12;
    }
    while (i + 3 <= un) {
        unsigned long v = ((unsigned long)units[i] << 16) |
                          ((unsigned long)units[i + 1] << 8) | units[i + 2];
        out[o++] = b64_alphabet[(v >> 18) & 63];
        out[o++] = b64_alphabet[(v >> 12) & 63];
        out[o++] = b64_alphabet[(v >> 6) & 63];
        out[o++] = b64_alphabet[v & 63];
        i += 3;
    }
    if (un - i == 1) {
        unsigned long v = (unsigned long)units[i] << 16;
        out[o++] = b64_alphabet[(v >> 18) & 63];
        out[o++] = b64_alphabet[(v >> 12) & 63];
        out[o++] = '=';
        out[o++] = '=';
    }
    else if (un - i == 2) {
        unsigned long v = ((unsigned long)units[i] << 16) |
                          ((unsigned long)units[i + 1] << 8);
        out[o++] = b64_alphabet[(v >> 18) & 63];
        out[o++] = b64_alphabet[(v >> 12) & 63];
        out[o++] = b64_alphabet[(v >> 6) & 63];
        out[o++] = '=';
    }
    out[o] = '\0';
    espk_free(units);
    *outp = out;
    return kESErrOK;
}

/* b64encode(s) -> base64 string (Latin1 input; else error 10002). */
ESB64_API long b64encode(TaggedData* argv, long argc, TaggedData* retval)
{
    long rc;
    char* out = NULL;
    if (argc != 1 || argv[0].type != kTypeString) {
        return kESErrBadArgumentList;
    }
    rc = b64_encode_whatwg(argv[0].data.string, strlen(argv[0].data.string), &out);
    if (rc != kESErrOK) {
        return rc;
    }
    retval->type = kTypeString;
    retval->data.string = out;
    return kESErrOK;
}

/* ---- ESPK_TEST_MAIN: allocator stress hook ------------------------------
 * Compiles to a freestanding console main() (no exports needed; kernel32
 * supplies VirtualAlloc/VirtualFree). Uses ONLY espk_malloc/espk_free/
 * strlen/memcpy/memset and plain loops - no CRT. Returns 0 on success, or a
 * nonzero stage number (1..5) on failure.
 * Build: clang --target=x86_64-pc-windows-msvc -O2 -DESPK_TEST_MAIN
 *        -march=x86-64-v2 native/espk-b64.c -o espk-test.exe kernel32.lib
 */
#ifdef ESPK_TEST_MAIN

/* deterministic LCG (no CRT rand) */
static unsigned long g_test_rng = 0x12345678u;

static unsigned long test_rand(void)
{
    g_test_rng = g_test_rng * 1664525u + 1013904223u;
    return g_test_rng;
}

/* deterministic fill/check pattern for owner index i */
static void test_fill(unsigned char* p, size_t n, size_t i)
{
    size_t k;
    for (k = 0; k < n; k++) {
        p[k] = (unsigned char)((i * 131u + k) & 0xFFu);
    }
}

static int test_check(const unsigned char* p, size_t n, size_t i)
{
    size_t k;
    for (k = 0; k < n; k++) {
        if (p[k] != (unsigned char)((i * 131u + k) & 0xFFu)) {
            return 1;
        }
    }
    return 0;
}

/* stage 1 + 5 share the long-lived-session block table (file scope so stage
   5 can free what stage 1 deliberately keeps allocated) */
#define TEST_LIVE_N 2000
static void* g_t1_blk[TEST_LIVE_N];
static size_t g_t1_sz[TEST_LIVE_N];

/* stage 1: long-lived session - ~2000 buffers of 8-32 KiB kept allocated
   with NO frees. This crosses the 16 MiB static pool (~40 MiB total); the
   OLD fixed-pool allocator returns NULL here. Assert every allocation
   succeeds, the arena grew past the static segment, and every buffer's
   contents verify (catches overlap/aliasing). */
static int test_stage1(void)
{
    size_t i;
    for (i = 0; i < TEST_LIVE_N; i++) {
        g_t1_sz[i] = 8u * 1024u + (size_t)(test_rand() % (24u * 1024u));
        g_t1_blk[i] = espk_malloc(g_t1_sz[i]);
        if (g_t1_blk[i] == NULL) {
            return 1;
        }
        test_fill((unsigned char*)g_t1_blk[i], g_t1_sz[i], i);
    }
    for (i = 0; i < TEST_LIVE_N; i++) {
        if (test_check((const unsigned char*)g_t1_blk[i], g_t1_sz[i], i)) {
            return 1;
        }
    }
    if (espk_segment_count() <= 1 || espk_total_capacity() <= ESPK_POOL_SIZE) {
        return 1;
    }
    return 0;
}

/* stage 2: full alloc/free cycle - grow again, free everything, and assert
   every non-static segment that became empty was VirtualFree'd (segment
   count returns to its pre-stage value - stage 1's buffers are still live,
   so their segments must remain). Re-allocating after the release must
   succeed (seg0 free-list reuse). */
static int test_stage2(void)
{
    static void* blk[TEST_LIVE_N];
    static size_t sz[TEST_LIVE_N];
    size_t i;
    size_t before = espk_segment_count();
    for (i = 0; i < TEST_LIVE_N; i++) {
        sz[i] = 8u * 1024u + (size_t)(test_rand() % (24u * 1024u));
        blk[i] = espk_malloc(sz[i]);
        if (blk[i] == NULL) {
            return 1;
        }
        test_fill((unsigned char*)blk[i], sz[i], i + 4000u);
    }
    for (i = 0; i < TEST_LIVE_N; i++) {
        espk_free(blk[i]);
    }
    if (espk_segment_count() != before) {
        return 1; /* growth segments were not released */
    }
    for (i = 0; i < 128; i++) {
        void* q = espk_malloc(16u * 1024u);
        if (q == NULL) {
            return 1;
        }
        test_fill((unsigned char*)q, 16u * 1024u, i + 9000u);
        if (test_check((const unsigned char*)q, 16u * 1024u, i + 9000u)) {
            return 1;
        }
        espk_free(q);
    }
    if (espk_segment_count() != before) {
        return 1;
    }
    return 0;
}

/* stage 3: host-misuse guards - foreign pointers and double-frees are
   silent no-ops, and the allocator stays healthy afterwards. */
static int test_stage3(void)
{
    unsigned char stackbuf[64];
    void* a;
    void* b;
    size_t before = espk_segment_count();
    memset(stackbuf, 0, sizeof(stackbuf));
    a = espk_malloc(100);
    if (a == NULL) {
        return 1;
    }
    espk_free(a);
    espk_free(a); /* double free: must be a no-op */
    b = espk_malloc(100);
    if (b == NULL) {
        return 1;
    }
    test_fill((unsigned char*)b, 100, 0x11u);
    if (test_check((const unsigned char*)b, 100, 0x11u)) {
        return 1;
    }
    /* foreign pointers: stack object, bogus address, the ESInitialize
       signature literal, a pointer inside the pool that is not a valid
       block start (misaligned), and one-past-the-pool */
    espk_free(stackbuf);
    espk_free((void*)(unsigned long long)0x1234);
    espk_free((void*)"b64encode_s,b64decode_s,b64decodeToFile_ss");
    espk_free(g_pool + 4);
    espk_free(g_pool + ESPK_POOL_SIZE);
    if (espk_segment_count() != before) {
        return 1;
    }
    espk_free(b);
    return 0;
}

/* dedicated coalescing check (runs FIRST, on the pristine allocator so the
   block run is bump-contiguous in seg0): 512 x 8 KiB blocks freed odd-first
   then even-reverse must fully coalesce into ONE extent; a subsequent ~4 MiB
   allocation must be served by that coalesced run via first-fit WITHOUT
   growing a new segment (segment count stays 1 - growth would mean the
   coalesced extent was not produced). */
static int test_coalesce(void)
{
    enum { CB = 512 };
    static void* cb[CB];
    size_t total = CB * 8192u;
    size_t j;
    void* big;
    for (j = 0; j < CB; j++) {
        cb[j] = espk_malloc(8192);
        if (cb[j] == NULL) {
            return 1;
        }
    }
    for (j = 1; j < CB; j += 2) {
        espk_free(cb[j]); /* odd blocks */
    }
    /* even blocks, reverse order (coalesces each even with the adjacent
       already-free odd blocks, ending in one merged extent) */
    j = CB - 2;
    for (;;) {
        espk_free(cb[j]);
        if (j == 0) {
            break;
        }
        j -= 2;
    }
    big = espk_malloc(total - 4096);
    if (big == NULL) {
        return 1; /* coalescing did not yield the full extent */
    }
    if (espk_segment_count() != 1) {
        return 1; /* big was served by growth, not the coalesced run */
    }
    test_fill((unsigned char*)big, total - 4096, 0xABu);
    if (test_check((const unsigned char*)big, total - 4096, 0xABu)) {
        return 1;
    }
    espk_free(big);
    return 0;
}

/* stage 4: mixed alloc/free interleaving across many size classes, random
   sizes and random free order (stresses free-list reuse, address-ordered
   insertion and same-segment coalescing). */
static int test_stage4(void)
{
    static const size_t classes[] = {
        0, 1, 2, 3, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128,
        129, 255, 256, 257, 511, 1023, 1024, 4095, 4096, 8192, 16384, 32768,
        65535, 65536, 65537, 131072, 262144, 1048576
    };
    enum { MAX_SLOTS = 256 };
    static void* slots[MAX_SLOTS];
    static size_t slot_n[MAX_SLOTS];
    static size_t slot_i[MAX_SLOTS];
    unsigned long round;
    size_t live = 0;
    size_t k;
    for (k = 0; k < MAX_SLOTS; k++) {
        slots[k] = NULL;
    }
    for (round = 0; round < 4000; round++) {
        if (live == 0 || (test_rand() & 1u) != 0) {
            for (k = 0; k < MAX_SLOTS; k++) {
                if (slots[k] == NULL) {
                    break;
                }
            }
            if (k < MAX_SLOTS) {
                size_t cls = (size_t)(test_rand() %
                                      (sizeof(classes) / sizeof(classes[0])));
                size_t n = classes[cls];
                void* p = espk_malloc(n);
                if (p == NULL) {
                    return 1;
                }
                slots[k] = p;
                slot_n[k] = n;
                slot_i[k] = 1000u + (size_t)round;
                if (n > 0) {
                    test_fill((unsigned char*)p, n, slot_i[k]);
                }
                live++;
            }
        }
        else {
            size_t pick = (size_t)(test_rand() % MAX_SLOTS);
            if (slots[pick] != NULL) {
                espk_free(slots[pick]);
                slots[pick] = NULL;
                live--;
            }
        }
        if ((round & 63u) == 0) {
            for (k = 0; k < MAX_SLOTS; k++) {
                if (slots[k] != NULL && slot_n[k] > 0 &&
                    test_check((const unsigned char*)slots[k], slot_n[k],
                               slot_i[k])) {
                    return 1;
                }
            }
        }
    }
    for (k = 0; k < MAX_SLOTS; k++) {
        if (slots[k] != NULL) {
            espk_free(slots[k]);
            slots[k] = NULL;
        }
    }
    return 0;
}

/* stage 5: free stage 1's still-live buffers; every non-static segment must
   now be released (only seg0 remains) and the allocator must keep working. */
static int test_stage5(void)
{
    size_t i;
    for (i = 0; i < TEST_LIVE_N; i++) {
        espk_free(g_t1_blk[i]);
    }
    if (espk_segment_count() != 1) {
        return 1;
    }
    for (i = 0; i < 64; i++) {
        void* q = espk_malloc(32u * 1024u);
        if (q == NULL) {
            return 1;
        }
        test_fill((unsigned char*)q, 32u * 1024u, i + 0x55u);
        if (test_check((const unsigned char*)q, 32u * 1024u, i + 0x55u)) {
            return 1;
        }
        espk_free(q);
    }
    if (espk_segment_count() != 1) {
        return 1;
    }
    return 0;
}

int main(void)
{
    int rc;
    rc = test_coalesce();
    if (rc != 0) {
        return 1;
    }
    rc = test_stage1();
    if (rc != 0) {
        return 2;
    }
    rc = test_stage2();
    if (rc != 0) {
        return 3;
    }
    rc = test_stage3();
    if (rc != 0) {
        return 4;
    }
    rc = test_stage4();
    if (rc != 0) {
        return 5;
    }
    rc = test_stage5();
    if (rc != 0) {
        return 6;
    }
    return 0;
}

#endif /* ESPK_TEST_MAIN */
