# Native ABI reference

`lmdb.h` is the exact, unmodified public header from the signed annotated
OpenLDAP tag `LMDB_1.0.0`. The tag object
`92e058212dd0ce262e714623609502b37a8ac8d0` peels to commit
`2562c3297402d82bbc049c7e645515edb4079eba`. Its canonical version string is
`LMDB 1.0.0: (June 30, 2026)`.

The pinned source archive is:

```text
https://git.openldap.org/openldap/openldap/-/archive/LMDB_1.0.0/openldap-LMDB_1.0.0.tar.gz
SHA-256 a61ded12bd9c670038b77483dda13b50684a93a111e53421dfb979624ae9f72e
```

The retained `libraries/liblmdb/lmdb.h` has this checksum:

```text
SHA-256 b9267c09ade0147e224316d0195c8ee3e9b8cc130ba196fad020bccb7b1cd043
```

The header is retained only as review material for the Deno FFI ABI
declarations. This package ships no LMDB implementation, source archive,
static library, or shared library. Users must provide the LMDB 1.0.0 shared
library separately through `LMDB_LIB_PATH`.

LMDB and this header are distributed under the OpenLDAP Public License. See
the license notice inside `lmdb.h` and the upstream OpenLDAP source for the
complete terms.

## Updating

1. Choose a stable signed upstream LMDB tag and record its tag object, peeled
   commit, canonical version string, archive URL, and license.
2. Download the tag archive outside this repository and verify the archive
   SHA-256 before extracting it.
3. Verify the unmodified `libraries/liblmdb/lmdb.h` SHA-256, then copy only
   that file to `native/lmdb.h`.
4. Audit every imported declaration, error code, structure layout, and
   ABI-dependent offset in `src/native/` against the new header and a compiled
   C oracle.
5. Update exact runtime-version validation and run the full compatibility
   suite.

Never accept a later `1.0.x` version automatically: every native version needs
a fresh version and ABI audit.
