# pi-fast-resume

Мгновенный `/resume` для [pi](https://pi.dev): оригинальный пикер сессий, данные которому подаёт фоновый индекс вместо чтения диска в TUI-потоке.

## Зачем

Встроенный `SessionManager.list/listAll` при каждом открытии пикера читает начало и хвост каждого session-файла. На корпусе из тысяч сессий (реальный корпус: ~3050 файлов, ~3,4 GiB) это даёт ощутимую задержку перед показом списка.

Расширение повторяет штатный `/resume` бит-в-бит, но `SessionInfo[]` собирается из SQLite-индекса метаданных, который поддерживает worker thread: TUI не читает диск и не парсит JSON.

## Архитектура

```text
/resume-fast ──► SessionSelectorComponent (оригинальный UI pi)
                     │ loaders
                     ▼
              Worker Thread + SQLite (path → size,mtime,id,cwd,name,…)
                     │ дифф по size+mtime; head/tail — только новые/изменённые файлы
                     ▼
              ~/.pi/agent/sessions/**/*.jsonl
```

- Никакого полнотекстового индекса содержимого.
- Rename — append `session_info` записи в конец файла, воркером.
- Скрытие сабагентных сессий (`parentSession` в header + имя вида `name#8-hex`) — фильтр запроса, toggle хоткеем.

## Статус

Проект в стадии проектирования; реализация не начата. Решения дизайн-сессии фиксируются в `CONTEXT.md` и `docs/adr/`.

## Установка (после первой рабочей версии)

```bash
pi install /path/to/pi-fast-resume   # локально
```

## Разработка

```bash
npm install
npm run typecheck
npm run lint
npm test
```
