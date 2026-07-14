// Audited against LMDB 1.0.0. This intentionally exposes only the
// node-lmdb-relevant common subset, excluding crypto, two-phase-commit, and
// remap-cache APIs.
export const lmdbSymbols = {
  mdb_cmp: {
    parameters: ['pointer', 'u32', 'buffer', 'buffer'], // MDB_txn *txn, MDB_dbi dbi, const MDB_val *a, const MDB_val *b
    result: 'i32',
  },
  mdb_cursor_close: {
    parameters: ['pointer'], // MDB_cursor *cursor
    result: 'void',
  },
  mdb_cursor_count: {
    parameters: ['pointer', 'buffer'], // MDB_cursor *cursor, mdb_size_t *countp
    result: 'i32',
  },
  mdb_cursor_dbi: {
    parameters: ['pointer'], // MDB_cursor *cursor
    result: 'u32', // MDB_dbi
  },
  mdb_cursor_del: {
    parameters: ['pointer', 'u32'], // MDB_cursor *cursor, unsigned int flags
    result: 'i32', // int
  },
  mdb_cursor_get: {
    parameters: ['pointer', 'buffer', 'buffer', 'u32'], // MDB_cursor *cursor, MDB_val *key, MDB_val *data, MDB_cursor_op op
    result: 'i32',
  },
  mdb_cursor_open: {
    parameters: ['pointer', 'u32', 'buffer'], // MDB_txn *txn, MDB_dbi dbi, MDB_cursor **cursor
    result: 'i32',
  },
  // mdb_cursor_put
  // mdb_cursor_renew
  // mdb_cursor_txn
  mdb_dbi_close: {
    parameters: ['pointer', 'u32'], // MDB_env *env, MDB_dbi dbi
    result: 'void',
  },
  // mdb_dbi_flags
  mdb_dbi_open: {
    parameters: ['pointer', 'buffer', 'u32', 'buffer'], // MDB_txn *txn, const char *name, unsigned int flags, MDB_dbi *dbi
    result: 'i32', // int
  },
  // mdb_dcmp
  mdb_del: {
    parameters: ['pointer', 'u32', 'buffer', 'buffer'], // MDB_txn *txn, MDB_dbi dbi, MDB_val *key, MDB_val *data
    result: 'i32', // int
  },
  mdb_drop: {
    parameters: ['pointer', 'u32', 'i32'], // MDB_txn *txn, MDB_dbi dbi, int del
    result: 'i32', // int
  },
  mdb_env_close: {
    parameters: ['pointer'], // MDB_env *env
    result: 'void',
  },
  // mdb_env_copy
  mdb_env_copy2: {
    parameters: ['pointer', 'buffer', 'u32'], // MDB_env *env, const char *path, unsigned int flags
    result: 'i32', // int
    nonblocking: true,
  },
  // mdb_env_copyfd
  // mdb_env_copyfd2
  mdb_env_create: {
    parameters: ['buffer'], // MDB_env **env
    result: 'i32', // int
  },
  // mdb_env_get_fd
  mdb_env_get_flags: {
    parameters: ['pointer', 'buffer'], // MDB_env *env, unsigned int *flags
    result: 'i32', // int
  },
  mdb_env_get_maxkeysize: {
    parameters: ['pointer'], // MDB_env *env
    result: 'i32', // int
  },
  // mdb_env_get_maxreaders
  // mdb_env_get_path
  // mdb_env_get_userctx
  mdb_env_info: {
    parameters: ['pointer', 'buffer'], // MDB_env *env, MDB_envinfo *stat
    result: 'i32', // int,
  },
  mdb_env_open: {
    parameters: ['pointer', 'buffer', 'u32', 'u32'], // MDB_env *env, const char *path, unsigned int flags, mdb_mode_t mode
    result: 'i32', // int
  },
  // mdb_env_set_assert
  // mdb_env_set_flags
  mdb_env_set_mapsize: {
    parameters: ['pointer', 'usize'], // MDB_env *env, mdb_size_t size
    result: 'i32',
  },
  mdb_env_set_maxdbs: {
    parameters: ['pointer', 'u32'], // MDB_env *env, MDB_dbi dbs; typedef unsigned int MDB_dbi;
    result: 'i32', // int
  },
  mdb_env_set_maxreaders: {
    parameters: ['pointer', 'u32'], // MDB_env *env, unsigned int readers
    result: 'i32', // int
  },
  // mdb_env_set_userctx
  mdb_env_stat: {
    parameters: ['pointer', 'buffer'], // MDB_env *env, MDB_stat *stat
    result: 'i32', // int
  },
  mdb_env_sync: {
    parameters: ['pointer', 'i32'], // MDB_env *env, int force
    result: 'i32', // int
    nonblocking: true,
  },
  mdb_get: {
    parameters: ['pointer', 'u32', 'buffer', 'buffer'], // MDB_txn *txn, MDB_dbi dbi, MDB_val *key, MDB_val *data
    result: 'i32', // int
  },
  mdb_put: {
    parameters: ['pointer', 'u32', 'buffer', 'buffer', 'u32'], // MDB_txn *txn, MDB_dbi dbi, MDB_val *key, MDB_val *data, unsigned int flags
    result: 'i32', // int
  },
  // mdb_reader_check
  // mdb_reader_list
  // mdb_set_compare
  // mdb_set_dupsort
  // mdb_set_relctx
  // mdb_set_relfunc
  mdb_stat: {
    parameters: ['pointer', 'u32', 'buffer'], // MDB_txn *txn, MDB_dbi dbi, MDB_stat *stat
    result: 'i32', // int
  },
  mdb_strerror: {
    parameters: ['i32'], // int err
    result: 'pointer', // char *
  },
  mdb_txn_abort: {
    parameters: ['pointer'], // MDB_txn *txn
    result: 'void',
  },
  mdb_txn_begin: {
    parameters: ['pointer', 'pointer', 'u32', 'buffer'], // MDB_env *env, MDB_txn *parent, unsigned int flags, MDB_txn **txn
    result: 'i32', // int
  },
  mdb_txn_commit: {
    parameters: ['pointer'], // MDB_txn *txn
    result: 'i32', // int
  },
  // mdb_txn_env
  // mdb_txn_id
  mdb_txn_renew: {
    parameters: ['pointer'], // MDB_txn *txn
    result: 'i32', // int
  },
  mdb_txn_reset: {
    parameters: ['pointer'], // MDB_txn *txn
    result: 'void', // void
  },
  mdb_version: {
    parameters: ['buffer', 'buffer', 'buffer'], // int *major, int *minor, int *patch
    result: 'pointer', // char *
  },
} as const;

export type LmdbSymbols = typeof lmdbSymbols;
