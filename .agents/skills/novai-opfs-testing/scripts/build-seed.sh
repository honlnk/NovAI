#!/usr/bin/env bash
# 从真实 NovAI 项目目录构建 OPFS 种子 JSON（源项目只读）。
#
# 用法:
#   PROJECT_DIR=~/note/test-novel ./build-seed.sh [输出路径]
# 环境变量:
#   PROJECT_DIR          源项目目录（默认 ~/note/test-novel）
#   INJECT_LEGACY_BLOCK  设为 gardener 时向 novel.config.json 注入旧字段块（迁移测试用）
#   MANIFEST             收集清单路径（默认 <脚本所在目录>/../references/seed-manifest.txt）
#   NO_VALIDATE=1        跳过 jsonschema 校验（缺依赖时的逃生门，不建议常用）
# 依赖: python3；jsonschema CLI 或 python3 -m jsonschema（pip install jsonschema）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$HOME/note/test-novel}"
PROJECT_DIR="${PROJECT_DIR/#\~/$HOME}"
MANIFEST="${MANIFEST:-$SCRIPT_DIR/../references/seed-manifest.txt}"
SCHEMA="$SCRIPT_DIR/../assets/seed.schema.json"
OUT="${1:-/tmp/novai-opfs-seed.json}"
INJECT="${INJECT_LEGACY_BLOCK:-}"

[[ -d "$PROJECT_DIR" ]] || { echo "源项目不存在: $PROJECT_DIR" >&2; exit 1; }
[[ -f "$PROJECT_DIR/novel.config.json" ]] || { echo "源项目缺 novel.config.json: $PROJECT_DIR" >&2; exit 1; }
[[ -f "$MANIFEST" ]] || { echo "清单不存在: $MANIFEST" >&2; exit 1; }
command -v python3 >/dev/null || { echo "需要 python3" >&2; exit 1; }

# jsonschema 校验通道：优先独立 CLI，退到 python3 -m；NO_VALIDATE=1 可跳过
JSONSCHEMA_CMD=()
if command -v jsonschema >/dev/null; then
  JSONSCHEMA_CMD=(jsonschema)
elif python3 -m jsonschema --help >/dev/null 2>&1; then
  JSONSCHEMA_CMD=(python3 -m jsonschema)
elif [[ "${NO_VALIDATE:-}" != "1" ]]; then
  echo "缺 jsonschema（pip install jsonschema；或 NO_VALIDATE=1 跳过校验）" >&2
  exit 1
fi

PROJECT_DIR="$PROJECT_DIR" MANIFEST="$MANIFEST" INJECT="$INJECT" OUT="$OUT" python3 - <<'PYEOF'
import json, os, sys, datetime

project = os.environ["PROJECT_DIR"]
manifest_path = os.environ["MANIFEST"]
inject = os.environ.get("INJECT") or None
out = os.environ["OUT"]

TEXT_EXTS = {".md", ".txt", ".json"}

def is_text(rel):
    return os.path.splitext(rel)[1].lower() in TEXT_EXTS

# 解析清单：精确路径 + 尾缀 * 的目录通配
exact, globs = [], []
for raw in open(manifest_path, encoding="utf-8"):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    (globs if line.endswith("*") else exact).append(line.rstrip("*").rstrip("/"))

files, warnings = {}, {}

def add(rel):
    src = os.path.join(project, rel)
    if not os.path.isfile(src):
        warnings[rel] = "不存在，跳过"
        return
    if not is_text(rel):
        warnings[rel] = "非文本扩展名，跳过"
        return
    with open(src, encoding="utf-8") as f:
        files[rel] = f.read()

for rel in exact:
    add(rel)
for base in globs:
    root = os.path.join(project, base)
    if not os.path.isdir(root):
        warnings[base + "/*"] = "目录不存在，跳过"
        continue
    for dirpath, _, names in os.walk(root):
        for name in sorted(names):
            add(os.path.relpath(os.path.join(dirpath, name), project))

if "novel.config.json" not in files:
    print("清单未收集到 novel.config.json，种子不可用", file=sys.stderr)
    sys.exit(1)

if inject == "gardener":
    cfg = json.loads(files["novel.config.json"])
    cfg["gardener"] = {
        "model": cfg.get("model") or "deepseek-chat",
        "reasoningEffort": "medium",
    }
    files["novel.config.json"] = json.dumps(cfg, ensure_ascii=False, indent=2)

seed = {
    "version": 1,
    "source": project,
    "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "files": dict(sorted(files.items())),
}
if inject:
    seed["injectedLegacyBlock"] = inject

with open(out, "w", encoding="utf-8") as f:
    json.dump(seed, f, ensure_ascii=False)

print(f"收集 {len(files)} 个文件 -> {out}")
for rel, why in warnings.items():
    print(f"  警告: {rel}: {why}", file=sys.stderr)
PYEOF

# 结构校验（jsonschema：-i 实例文件，位置参数为 schema）
if [[ "${NO_VALIDATE:-}" == "1" ]]; then
  echo "已按 NO_VALIDATE=1 跳过 schema 校验"
else
  "${JSONSCHEMA_CMD[@]}" -i "$OUT" "$SCHEMA" && echo "schema 校验通过"
fi
ls -lh "$OUT" | awk '{print "种子大小:", $5}'
