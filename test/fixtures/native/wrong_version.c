#if defined(_WIN32)
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

EXPORT const char *mdb_version(int *major, int *minor, int *patch) {
  if (major != 0) *major = 0;
  if (minor != 0) *minor = 9;
  if (patch != 0) *patch = 35;
  return "LMDB 0.9.35: (Jan 27, 2026)";
}
