# Локальная v0.1.0 запускает src/worker.ts напрямую

---
status: accepted
---

В локальном rollout worker создаётся как `new Worker(new URL("./worker.ts", import.meta.url))`. На Node 22.21.1 это проверено: local TypeScript worker запускается с type stripping без дополнительного build step и без предупреждения. Такой путь сохраняет единый TypeScript-код и быстрый `/reload`. Ограничение записано явно: Node не type-strip'ит `.ts` внутри `node_modules`, поэтому npm publish в будущем потребует отдельной задачи по compiled JavaScript worker и compatibility check; в v0.1.0 publish не входит (ADR-0022).
