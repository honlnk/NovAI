// 页面内播种 + 换柄。在 http://localhost:5173/ 页面上下文执行（control-browser 的 evaluate）。
// 用法：把本文件内容粘进 evaluate，末尾改成 `await seedNovaiOpfs(seedJson)` 作为返回值——
// seedJson 是种子对象本身（build-seed.sh 的产物），不是字符串。
// 纯 JS（IAB 的 evaluate 不认 TS 语法）。返回 { filesWritten, recordsUpdated }。
// 文件多时把这次 evaluate 的 timeout 顶到接近 120s，或把种子分两半调两次（换柄只在最后一次也有副作用，无妨）。
async function seedNovaiOpfs(seedJson) {
  if (!seedJson || !seedJson.files) throw new Error('种子格式不对：缺 files 字段');
  const root = await navigator.storage.getDirectory();

  // 1) 清空 OPFS 根
  for await (const entry of root.values()) {
    await root.removeEntry(entry.name, { recursive: true }).catch(() => {});
  }

  // 2) 逐文件写入（按路径逐级建目录）
  let filesWritten = 0;
  for (const [path, content] of Object.entries(seedJson.files)) {
    const parts = path.split('/');
    const fileName = parts.pop();
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const fh = await dir.getFileHandle(fileName, { create: true });
    const w = await fh.createWritable();
    await w.write(new TextEncoder().encode(content));
    await w.close();
    filesWritten += 1;
  }

  // 3) 换柄：recent-projects 所有记录的 handle 换成 OPFS 根
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('novai-projects');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const recordsUpdated = await new Promise((resolve, reject) => {
    const tx = db.transaction('recent-projects', 'readwrite');
    const store = tx.objectStore('recent-projects');
    const getAll = store.getAll();
    getAll.onsuccess = () => {
      let n = 0;
      for (const rec of getAll.result) {
        rec.handle = root;
        rec.rootName = '';
        store.put(rec);
        n += 1;
      }
      tx.oncomplete = () => resolve(n);
    };
    getAll.onerror = () => reject(getAll.error);
  });
  db.close();

  return { filesWritten, recordsUpdated };
}
