# Волна Desktop — беклог

Каждая итерация: маленький кусок, сборка, запуск, коммит с тегом.

## Итерация 1 — окно и каркас
- [ ] Tauri 2 окно 1100×720, тёмный фон, моно-шрифт, Dela Gothic One для заголовков
- [ ] Пустые экраны: Волна / Коллекция / Поиск / Сейчас играет (только заглушки)
- [ ] Сборка `cargo build` проходит на Windows (gnu toolchain)

## Итерация 2 — вход
- [ ] OAuth Яндекса во вебвью (перехват `access_token` из редиректа, как `LoginView.swift`)
- [ ] Токен в Windows Credential Manager (crate `keyring`)
- [ ] Проверка `account/status`, сохранение uid

## Итерация 3 — API-клиент (только чтение)
- [ ] `YMClient` на reqwest: заголовки `Authorization: OAuth`, `X-Yandex-Music-Client`
- [ ] Коллекция: лайки треков, плейлисты
- [ ] Поиск: `search?type=all`

## Итерация 4 — стриминг без звука
- [ ] `get-file-info` с HMAC-подписью (ключ из `YMClient.swift`)
- [ ] AES-CTR расшифровка lossless (`AESCTR` из `StreamResolver.swift`)
- [ ] Legacy MP3 через `download-info` + MD5-соль

## Итерация 5 — звук
- [ ] symphonia декодирование mp3/aac/flac
- [ ] cpal вывод (WASAPI), play/pause/seek
- [ ] Предзагрузка следующего трека

## Итерация 6 — Моя волна
- [ ] `rotor/session/new`, `tracks`, batch
- [ ] Отчёты как на iOS: `trackStarted`, `trackFinished`, `skip`, `like`, `dislike`, `radioStarted` (`from=radio-mobile-user-onyourwave`)
- [ ] `play-audio` с `from` для обучения волны

## Итерация 7 — текст песен
- [ ] Yandex lyrics (LRC и TEXT, HMAC-подпись)
- [ ] Fallback LRCLIB, караоке-подсветка по времени

## Итерация 8 — визуализатор
- [ ] rustfft → полосы bass/mid/high, детект кика
- [ ] Порт шейдера `CoverVisualizer.swift` на WebGL2 (эффект «Дым» и ASCII)
- [ ] Цвет акцента из обложки

## Итерация 9 — Windows
- [ ] SMTC (медиаклавиши, флайаут) через `souvlaki`
- [ ] Mica/Acrylic фон окна

## Итерация 10 — сборка и релиз
- [ ] `cargo tauri build` → `.exe` с двойным кликом
- [ ] README: как запустить

## Потом (не в MVP)
- Альбомы, артисты, клипы, плейлисты-редактирование, эквалайзер, Ynison
