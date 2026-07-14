#include <stddef.h>
#include <stdio.h>

#include "lmdb.h"

int main(void) {
  printf(
    "{\"pointer\":%zu,\"mdbSize\":%zu,\"dbi\":%zu,"
    "\"val\":[%zu,%zu,%zu],\"stat\":[%zu,%zu,%zu,%zu,%zu,%zu,%zu],"
    "\"envinfo\":[%zu,%zu,%zu,%zu,%zu,%zu,%zu],"
    "\"prevSnapshot\":%u,\"errors\":[%d,%d,%d,%d,%d,%d,%d,%d,%d]}\n",
    sizeof(void *), sizeof(mdb_size_t), sizeof(MDB_dbi),
    sizeof(MDB_val), offsetof(MDB_val, mv_size), offsetof(MDB_val, mv_data),
    sizeof(MDB_stat), offsetof(MDB_stat, ms_psize),
    offsetof(MDB_stat, ms_depth), offsetof(MDB_stat, ms_branch_pages),
    offsetof(MDB_stat, ms_leaf_pages), offsetof(MDB_stat, ms_overflow_pages),
    offsetof(MDB_stat, ms_entries),
    sizeof(MDB_envinfo), offsetof(MDB_envinfo, me_mapaddr),
    offsetof(MDB_envinfo, me_mapsize), offsetof(MDB_envinfo, me_last_pgno),
    offsetof(MDB_envinfo, me_last_txnid), offsetof(MDB_envinfo, me_maxreaders),
    offsetof(MDB_envinfo, me_numreaders),
    MDB_PREVSNAPSHOT, MDB_KEYEXIST, MDB_NOTFOUND, MDB_BAD_VALSIZE,
    MDB_BAD_CHECKSUM, MDB_CANT_ROLLBACK, MDB_DBIS_BUSY, MDB_ENV_BUSY,
    MDB_IS_READONLY, MDB_ADDR_BUSY
  );
  return 0;
}
