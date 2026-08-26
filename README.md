# pi-fast-resume

Быстрый аналог штатного `/resume` для [Pi](https://pi.dev). Переиспользует оригинальный `SessionSelectorComponent`, но получает `SessionInfo[]` из SQLite-индекса, который обновляет worker thread. Пикер не читает JSONL и не парсит их в TUI-потоке.

## Возможности

- `/rf` и `/resume-fast` открывают полноразмерный resume picker.
- Стандартный UI Pi: поиск, threaded/recent/relevance sort, Tab для Current Folder/All, Ctrl+P, Ctrl+N, Ctrl+R и Ctrl+D.
- Worker потоково разбирает только новые и изменённые JSONL по `size + mtime` и хранит точные picker-метаданные: `name`, `firstMessage`, `messageCount`, `cwd`, связи веток и время активности.
- `Alt+G` временно показывает/скрывает сессии pi-subagents. По умолчанию они скрыты; обычные fork/clone не фильтруются.
- Первый запуск показывает picker сразу и наполняет его по checkpoint-пакетам; последующие открытия используют готовый индекс.
- `/rf reindex` очищает только производный индекс и запускает rebuild.
- Несколько Pi-процессов координируют scan через SQLite lease, поэтому не дублируют обход диска.

## Архитектура

```text
/rf ──► полноразмерный overlay + SessionSelectorComponent
                              │
                              ▼
                       worker thread
                              │
                              ▼
      SQLite metadata index + streaming JSONL metadata-pass
                              │
                              ▼
                  ctx.sessionManager.getSessionDir()
```

Полный текст диалогов и FTS в индекс не попадают. Поиск оригинального picker использует ограниченный суррогат `name + firstMessage + cwd`.

## Установка

Локальная v0.1.0 подключается как Pi package:

```bash
pi install /home/spike/hobby/pi-fast-resume
```

Затем перезапусти Pi или выполни `/reload`.

> `src/worker.ts` запускается напрямую на Node 22 для локального package path. npm publish в эту версию не входит: Node не type-strip'ит `.ts` worker внутри `node_modules`.

## Использование

```text
/rf
/resume-fast
/rf reindex
```

В picker:

- `Alt+G` — показать/скрыть сабагентов до закрытия overlay;
- остальные клавиши совпадают со штатным `/resume`.

## Разработка

```bash
npm install
npm run typecheck
npm run lint
npm test
pi -e ./src/index.ts
```

Тесты используют только synthetic JSONL fixtures. Реальный локальный корпус подходит для ручного performance smoke, но не попадает в git.
