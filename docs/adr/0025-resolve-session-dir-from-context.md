# Корень session-файлов берётся из ctx.sessionManager.getSessionDir()

---
status: accepted
---

При первом запуске worker получает session root из `ctx.sessionManager.getSessionDir()`. Путь `~/.pi/agent/sessions` нигде не хардкодится. Это сохраняет совместимость со штатным Pi при `PI_CODING_AGENT_SESSION_DIR`, настройках кастомного sessionDir и integration smoke во временном каталоге. Воркер получает уже разрешённый путь от main thread как plain string.
