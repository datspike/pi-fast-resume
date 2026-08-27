# pi-fast-resume — правила для агентов

## Что это за репозиторий

Локальное Pi-расширение с быстрым picker’ом сессий: публичный `SessionSelectorComponent` получает метаданные из SQLite-индекса в worker thread. Команды: `/rf`, `/resume-fast`, `/fork-resume`, `/fr` и `/rf reindex`.

Перед работой прочитай этот файл и `README.md`; для терминов и архитектурных решений — `CONTEXT.md` и нужный ADR из `docs/adr/`.

## Границы реализации

- Не переписывай UI picker’а: используй публичный `SessionSelectorComponent`, подменяя только загрузчики данных.
- Main/TUI thread не сканирует и не разбирает session JSONL и не импортирует `better-sqlite3`; эта работа принадлежит `src/worker.ts`.
- Не добавляй FTS и полный текст сообщений в индекс. Допустимы только документированные метаданные, включая `firstMessage`.
- Сохраняй штатные semantics Pi для resume, rename, delete и fork. `/fork-resume` и `/fr` не должны предлагать текущую сессию как источник.
- Путь session root получай из `ctx.sessionManager`, не хардкодь `~/.pi/agent/sessions`.

## API и совместимость

- Сверяй контракты с установленными declaration files `@earendil-works/pi-coding-agent` и `@earendil-works/pi-tui`; не полагайся на private поля без version-aware причины и smoke.
- Текущая поддержанная среда: Pi `0.84.3`, Node `22.21.1`, local package path.
- `src/worker.ts` запускается напрямую только для local rollout. Не заявляй npm-публикацию готовой и не меняй `package.json` на publish-ready без compiled JavaScript worker и чистого install smoke.

## Проверки и коммиты

Перед статусом «проверено» выполни:

```bash
npm run typecheck && npm run lint && npm test
pi -e ./src/index.ts
```

Для изменений UI/команд выполни интерактивный Pi smoke. Как только версия прошла необходимые проверки — сразу сделай Conventional Commit (`feat:`, `fix:`, `docs:`, `test:` и т. п.).

## Данные и документация

- Не используй реальный корпус сессий в тестах, git или публичных примерах.
- Не раскрывай значения из `index.db`, имена сессий, `firstMessage` или пути пользователя в README, тестовых fixtures и отчётах.
- При изменении публичных команд, хранения индекса, поддержки платформ или privacy-границ синхронно обнови `README.md`.
