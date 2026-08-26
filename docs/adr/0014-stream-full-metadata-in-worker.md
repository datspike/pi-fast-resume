# Воркер потоково читает изменённый JSONL целиком для точных метаданных

---
status: accepted
supersedes: ADR-0006
---

Для нового или изменённого JSONL worker thread повторяет подход штатного `SessionManager.buildSessionInfo()`: читает файл через `createReadStream`, построчно разбирает JSONL и извлекает точные `name` (последняя `session_info`), `messageCount`, `lastActivityTime`, `parentSessionPath`, `cwd`, `id` и `firstMessage`. Полный текст диалога не сохраняется: `allMessagesText` остаётся ограниченным суррогатом из ADR-0001. Полный metadata-pass допустим, потому что выполняется вне TUI, с сохранением уже обработанных результатов в SQLite и прогрессом `x/y`; после первого прохода целиком читаются только файлы, у которых изменилась пара `size`+`mtime`. Это сохраняет значимые имена, включая pi-autoname, и даёт метаданные максимально близко к штатному `/resume`.
