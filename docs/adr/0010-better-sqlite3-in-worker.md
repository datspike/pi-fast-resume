# better-sqlite3 работает только внутри worker thread

---
status: accepted
---

Индекс использует `better-sqlite3` как runtime dependency, но соединение, транзакции и все синхронные SQL-операции существуют только в worker thread. Это даёт стабильный API, WAL и атомарные транзакции без `ExperimentalWarning`, который выдаёт доступный на Node 22.21.1 `node:sqlite`. Использование `better-sqlite3` в main thread запрещено: синхронная библиотека допустима только за границей TUI event loop. JSON-файл отклонён из-за отсутствия конкурентной дисциплины и удобных выборок.
