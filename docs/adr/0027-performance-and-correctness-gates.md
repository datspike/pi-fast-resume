# v0.1.0 имеет измеримые performance и correctness gates

---
status: accepted
---

Для корпуса пользователя (~3050 JSONL, ~3,4 GiB) hot `/rf` обязан показать первый кадр оригинального picker'а за ≤200 мс p95; cold `/rf` обязан показать пустой picker со статусом `Index warming up…` за ≤250 мс. Main thread не выполняет filesystem scan/read и не импортирует `better-sqlite3`; во время фонового scan TUI принимает ввод. После bootstrap количество index rows совпадает с discoverable JSONL, а synthetic fixtures совпадают со штатным Pi по `id`, `cwd`, `name`, `firstMessage`, `messageCount` и `parentSessionPath`. Это gates первой проверенной версии, без них commit как «готовой» запрещён.
