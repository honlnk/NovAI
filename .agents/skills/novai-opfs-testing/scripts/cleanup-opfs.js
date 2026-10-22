// 测试遗留物清理（页面侧两处）：删 recent-projects 测试记录 + 清空 OPFS 根。
// 在 http://localhost:5173/ 页面上下文执行：await cleanupNovaiOpfs()
// 返回 { recordsDeleted, opfsEntriesRemoved }。删完别忘了 shell 侧 rm /tmp/novai-opfs-seed*.json。
async function cleanupNovaiOpfs() {
  // 1) 删 recent-projects 里的测试记录（句柄为 OPFS 根的记录：handle.name 为空串；
  //    本地目录句柄 name 是目录名）。注意该表主键是 key 字段不是 projectId——
  //    同一 projectId 可有多条（last-opened 等），必须用 store.keyPath 取主键删除。
  let recordsDeleted = 0;
  let skipped = 0;
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('novai-projects');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('recent-projects', 'readwrite');
      const store = tx.objectStore('recent-projects');
      const keyPath = store.keyPath;
      const getAll = store.getAll();
      getAll.onsuccess = () => {
        for (const rec of getAll.result) {
          const isOpfs = rec.handle && typeof rec.handle.name === 'string' && rec.handle.name === '';
          if (isOpfs) {
            store.delete(rec[keyPath]);
            recordsDeleted += 1;
          } else {
            skipped += 1;
          }
        }
        tx.oncomplete = () => resolve();
      };
      getAll.onerror = () => reject(getAll.error);
    });
    db.close();
  } catch (e) {
    // 库不存在等情况视为无可清理
  }

  // 2) 清空 OPFS 根
  const root = await navigator.storage.getDirectory();
  let opfsEntriesRemoved = 0;
  for await (const entry of root.values()) {
    await root.removeEntry(entry.name, { recursive: true }).catch(() => {});
    opfsEntriesRemoved += 1;
  }

  return { recordsDeleted, recordsSkipped: skipped, opfsEntriesRemoved };
}
cleanupNovaiOpfs;
