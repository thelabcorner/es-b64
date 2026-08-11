/***************************************************************************
 * ESB64Native — WHATWG-exact base64 accelerator for the ESB64 library and
 * the ESPACK shared accelerator ("1" in the 1+n model).
 *
 * FREESTANDING build: no CRT, no SDK headers. Imports kernel32 only
 * (CreateFileW/WriteFile/CloseHandle/MultiByteToWideChar - declared below by
 * hand, the same pattern as the ArcFit freestanding EXEs), own minimal
 * free-list allocator over a static BSS pool (4 MiB - zeroed, adds nothing
 * to the file size), own memcpy/memset/strlen. Runs on any Windows x64
 * (>= Win10 2015; the build targets x86-64-v2, no AVX2/FMA requirement at
 * process startup). This slims the DLL from ~107 KB (default MSVC CRT) to
 * ~10-20 KB.
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

/* catchable custom error codes (>= 10000, ThioUtils convention) */
#define ESB64_ERR_B64_INVALID 10001 /* atob: malformed input */
#define ESB64_ERR_B64_LATIN1  10002 /* btoa: non-Latin1 input */
#define ESB64_ERR_FILE_WRITE  10003 /* b64decodeToFile: cannot write the target */
#define ESB64_ERR_NO_MEM      10004 /* allocator pool exhausted (positive:
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
 * First-fit free-list allocator over a static BSS pool. The pool is 4 MiB of
 * zero-initialized data (no file footprint). Sizing rationale: the string
 * channel can hold several returned kTypeString buffers alive at once (the
 * host frees them via ESFreeMem on ITS GC schedule), each up to 2x the
 * decoded payload (UTF-8 encoding) plus transient buffers - 4 MiB gives
 * comfortable margin for the multi-MB decode cases. Exhaustion returns NULL
 * -> ESB64_ERR_NO_MEM (10004, positive/catchable - never a negative code).
 */
#define ESPK_POOL_SIZE (4u << 20)
#define ESPK_ALIGN 8u

typedef struct EspkHdr {
    size_t size;
    void* next;
} EspkHdr;

static unsigned char g_pool[ESPK_POOL_SIZE];
static size_t g_cursor = 0;
static void* g_free = NULL;

static void* espk_malloc(size_t n)
{
    size_t need = (n + sizeof(EspkHdr) + ESPK_ALIGN - 1) & ~(size_t)(ESPK_ALIGN - 1);
    EspkHdr* h;
    void** pp = &g_free;
    if (need == 0) {
        need = sizeof(EspkHdr) + ESPK_ALIGN;
    }
    while (*pp != NULL) {
        h = (EspkHdr*)*pp;
        if (h->size >= need) {
            *pp = h->next;
            h->size = need;
            return (void*)((unsigned char*)h + sizeof(EspkHdr));
        }
        pp = (void**)&h->next;
    }
    if (g_cursor + need > ESPK_POOL_SIZE) {
        return NULL;
    }
    h = (EspkHdr*)(g_pool + g_cursor);
    g_cursor += need;
    h->size = need;
    h->next = NULL;
    return (void*)((unsigned char*)h + sizeof(EspkHdr));
}

static void espk_free(void* p)
{
    EspkHdr* h;
    if (p == NULL) {
        return;
    }
    h = (EspkHdr*)((unsigned char*)p - sizeof(EspkHdr));
    h->next = g_free;
    g_free = h;
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
    int has_ws = 0;
    if (!T_init) {
        init_T();
        T_init = 1;
    }

    /* early-exit whitespace scan (common case: none -> no compaction) */
    for (i = 0; i < n; i++) {
        if (T[(unsigned char)in[i]] == -2) {
            has_ws = 1;
            break;
        }
    }

    buf = (unsigned char*)espk_malloc(n + 1);
    if (buf == NULL) {
        return ESB64_ERR_NO_MEM;
    }
    if (has_ws) {
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
        for (i = 0; i < o; i++) {
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
