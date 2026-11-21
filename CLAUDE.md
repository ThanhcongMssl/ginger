# Ginger — trợ lý ảo cá nhân bằng giọng nói tiếng Việt

Người dùng là Công, senior front-end dev (Next.js, React, TypeScript). Trao đổi bằng
tiếng Việt, gọi người dùng là "anh", xưng "em".

## Mục tiêu
App mobile trợ lý ảo dựa trên AI:
- Trả lời câu hỏi về mọi chủ đề
- Có bộ nhớ, luôn nắm được các câu chuyện trước đó
- Giao tiếp bằng giọng nói tiếng Việt

## Các quyết định đã chốt
- **Nền tảng:** app mobile, dùng React Native + Expo (SDK 58), TypeScript
- **Dùng API trả phí, không tự host model:**
  - LLM: Claude. Model để chat: người dùng chọn dòng Haiku / Sonnet / Opus trong Cài đặt (mặc
    định Sonnet), không chọn phiên bản. `backend/app/chat_models.py` hỏi Models API lấy bản mới
    nhất của dòng đó (nhớ 1 giờ), chọn cách tắt thinking theo `capabilities` của model (Sonnet 5.5
    chỉ nhận `between_tools`, Haiku nhận `disabled`, Opus 5.5 không tắt được), lưu lựa chọn ở
    `users.chat_model` (agent chạy process riêng). Việc nền: `claude-haiku-5-5`
  - Embedding: Voyage AI `voyage-3.5` (1024 chiều)
  - Giọng nói (giai đoạn 3): STT bằng Soniox; TTS bằng Soniox hoặc Vbee/FPT.AI nếu cần giọng Việt tự nhiên hơn
- **Kiến trúc pipeline:** STT → LLM + bộ nhớ → TTS. Không dùng model speech-to-speech
  vì đắt và khó kiểm soát bộ nhớ.
- **Backend:** FastAPI + Postgres/pgvector. App không chứa API key của nhà cung cấp nào;
  app gọi backend bằng `APP_TOKEN` tự đặt.
- Câu trả lời viết theo văn nói, không markdown, để đưa thẳng vào TTS.
- Không hỏi ngược lại người dùng, vì khi nói chuyện bằng giọng mỗi câu hỏi tốn thêm một lượt.
  - Người dùng kể chuyện thì Gừng chỉ đáp một câu ngắn.
  - Gừng chỉ hỏi lại khi yêu cầu thiếu thông tin tới mức không làm được.
  - Đo bằng 8 câu kể chuyện / câu hỏi, prompt cũ: 5/7 câu kể chuyện bị hỏi ngược; prompt mới: 0/7.
  - Gừng chưa đặt được nhắc việc hay báo thức, được nhờ thì nói thật là chưa làm được.
- Tìm web (`WEB_SEARCH` trong llm.py): server tool `web_search_20250305` của Anthropic, `max_uses` 2,
  dùng cho cả nói và gõ chữ. Prompt dặn chỉ tìm khi cần thông tin mới (tin tức, giá, thời tiết…) và nói
  câu dẫn "Để Gừng xem nhé." trước khi tìm. Đo (Sonnet): câu cần tìm chữ đầu ~1–2s, xong ~4s, lặng ~2,7s
  sau câu dẫn, input ~18–20 nghìn token/lượt tìm (+10 USD/1.000 lượt); câu không cần tìm thì không tìm.
  Bản `web_search_20260209` (lọc kết quả bằng code) bị loại: chậm gấp 2–3 lần, gần gấp đôi token, và đọc
  cả lời tự nói nội bộ ("Kết quả trả về không đúng dạng dự kiến…"). `user_location` không nhận country VN.
- Đọc trang (`WEB_FETCH`, `web_fetch_20250910`): chỉ khi đoạn trích của web_search không đủ để trả lời;
  `url_sources` chỉ cho mở URL trong kết quả web_search (không mở link người dùng gửi), tối đa 1 trang,
  cắt ở 10.000 token. Đo (Sonnet): giá vàng, thời tiết, tỉ giá, xăng, bóng đá không đọc trang; lịch chiếu
  CGV có đọc (input ~35–44 nghìn token, xong 8–26s tuỳ trang mở nhanh hay chậm). Gừng được nói một câu
  ngắn giữa hai lần tìm/đọc (lấp khoảng lặng) nhưng prompt cấm chi tiết kỹ thuật.
- Thao tác trình duyệt (`backend/app/browser.py`): Gừng giao việc qua client tool `browser_task` (new / reply /
  cancel), nói "Dạ, Gừng làm đây, xong Gừng báo nhé." rồi thôi (không gọi Claude lần hai). Việc nằm ở bảng
  `browser_tasks`; worker `ginger-browser` (systemd, `python -m app.browser`) chạy vòng Claude Sonnet ↔ Playwright
  MCP (container `browser` trong docker-compose, cổng 127.0.0.1:8931, profile trong RAM, chặn gọi vào máy/mạng
  nhà). Chỉ cho các tool thao tác trang (không chạy JS, không tải file); không đăng nhập, không nhập thanh toán;
  bước không quay lại được (đặt, gửi, xoá…) thì dừng `need_confirmation`, anh đồng ý thì Gừng gọi `reply`, phiên
  trình duyệt giữ 10 phút. Kết quả ghi vào cuộc trò chuyện; agent giọng nói hỏi DB mỗi 2s và đọc bằng
  `session.say` (không qua llm_node), im lặng lúc trình duyệt đang làm thì chưa kết thúc phiên (tối đa 7 phút).
  Ảnh chụp trang bỏ link, cắt ở 20.000 ký tự, chỉ giữ nguyên 2 kết quả gần nhất (VnExpress ~127k ký tự gốc).
  Tên trang hay bị STT nghe sai: Gừng và trình duyệt đều được dặn đoán trang thật. Đo (client giả bằng giọng):
  tra phim đang chiếu 10–20s, ~25–45 nghìn token (phần lớn đọc từ cache); điền form + hỏi + gửi ~16s.
  Chế độ gõ chữ chưa tự hiện kết quả (mở lại chat mới thấy). Sửa browser.py thì `systemctl --user restart ginger-browser`.
- Gừng tự sửa mã nguồn (`backend/app/dev.py`): client tool `dev_task` (new / approve / revise / cancel), chỉ tài
  khoản trong `DEV_USER_IDS` (`backend/.env`) mới có tool này. Worker `ginger-dev` (systemd, `python -m app.dev`) clone
  repo ra `~/.local/share/ginger-dev/wt/<id>` (nhánh `gung/<id>`) rồi chạy `claude -p` (Claude Code, model `opus`,
  tính vào gói subscription qua `CLAUDE_CODE_OAUTH_TOKEN`, không dùng `ANTHROPIC_API_KEY`) trong sandbox bwrap: chỉ
  thấy bản clone, venv/node_modules (chỉ đọc) và HOME riêng; giấu nhà anh (repo gốc, .env, ~/.zshrc, ~/.ssh), /mnt
  (ổ Windows, chạy .exe), /run (systemd, Docker socket). Sandbox không có mạng (`--unshare-net`: không tới được
  Postgres, cổng nào trên máy hay Internet); lối ra duy nhất là proxy trong worker (unix socket, chỉ `POST
  /v1/messages*` tới api.anthropic.com) tự gắn token thật, trong sandbox chỉ có token giả. Tắt WebFetch; WebSearch
  chạy phía Anthropic nên vẫn dùng được. Cài gói: proxy CONNECT thứ hai chỉ cho tới npm, PyPI, api.expo.dev,
  reactnative.directory (`REGISTRY_HOSTS`); venv và node_modules trong sandbox là overlay riêng từng việc chồng lên
  bản thật (cài thoải mái, bản thật không đổi). Lúc áp dụng, đổi `requirements.txt` / `package.json` thì dev.py cài
  vào bản thật cũng trong sandbox (chỉ thấy đúng venv hay node_modules, mạng chỉ tới kho gói), vì cài gói là chạy
  script của gói. Gói native của app thì `ota.sh` từ chối, phải build lại trên Mac.
  Xong thì đọc tóm tắt và hỏi từng bước, anh đồng ý (Gừng gọi `approve`) mới làm: review → gộp ff vào main + khởi
  động lại backend/agent/browser (import thử trước; agent không "registered worker" trong 45s thì `git reset --keep`
  về bản cũ, lỗi đưa cho Claude khi anh bảo sửa tiếp) → ota (chỉ khi đổi `app/`, chạy `scripts/ota.sh`) → push (quét
  mẫu trong `~/.config/ginger/push-deny.txt` ngoài repo + giá trị trong hai file .env). Mọi bước chạm máy thật do
  dev.py làm, không phải Claude; không chạy git ngoài sandbox trong bản clone (hook do Claude viết), code ra bằng
  git bundle. Kết quả đọc lên trong 2 giờ. Đo: câu hỏi về code ~15s, sửa một dòng ~18s, áp dụng (gộp + khởi động
  lại + kiểm tra) ~21s. Đã thử: repo đang sửa dở trùng file thì từ chối gộp; cố ý làm worker trình duyệt chết lúc
  khởi động thì sau ~57s tự quay về bản cũ (dịch vụ phải chạy liền 12s cùng PID mới tính là lên).
- Việc chạy nền và cuộc gọi: Gừng đang làm việc được giao thì im lặng cũng chưa kết thúc phiên (`_end_when_idle` trong
  agent.py: trình duyệt tối đa 7 phút, sửa code 25 phút), đọc xong kết quả mới tính 20s im lặng như thường.
  Thông báo đẩy (`backend/app/push.py`, chạy trong lifespan backend): mọi kết quả đều gửi qua Expo Push tới mọi máy
  của tài khoản sau ~1s, kể cả khi agent đã đọc (bảng `push_tokens`, `pushed_at` trên hai bảng việc); app đang trong
  phòng trò chuyện thì tự ẩn (`setVoiceActive` trong push.ts), app ra nền thì iOS hiện. Lý do: server không biết chắc
  app đã ra nền: iOS treo app ngay, LiveKit còn thấy micro thêm tới ~20s (log thật: đọc "đã push" lúc anh đã tắt app,
  không có thông báo). Chạm vào thông báo → app mở, tự trò chuyện, Gừng đọc kết quả nếu chưa đọc. App: `src/push.ts`
  (`expo-notifications`, nạp lười) xin quyền + gửi token lên `POST /push/token` mỗi lần mở; Expo Go và web bỏ qua.
  Cần build mới (native) và key APNs trên EAS (build-ios.sh chạy tương tác, EAS hỏi thì chọn tạo push key).
  Agent chỉ đọc kết quả khi app còn trong phòng và đang gửi micro (`_user_here`); không thì để đó cho thông báo đẩy
  (log thật: phòng cũ treo vài giây sau khi mở lại app, đọc "đã push" vào đó nên mất cả lời lẫn thông báo).
  Đọc xong mà anh rời phòng trong 6s (`CONFIRM_HEARD_SEC`, hoặc phiên kết thúc trước) thì `unmark_announced`
  để lần mở app sau Gừng đọc lại. push.py hỏi biên nhận Expo (15s, 45s, 120s) và ghi log ("APNs đã nhận" / "không nhận").
  Đã thử vòng gửi bằng token giả (Expo báo DeviceNotRegistered → xoá token); chưa thử trên iPhone.
- Xưng hô (`PERSONA` trong backend/app/llm.py): trợ lý tự xưng "Gừng", mặc định gọi người
  dùng là "anh". Không có màn cài đặt: người dùng nói "gọi tôi là chị/bạn…" thì Gừng đổi ngay,
  và ký ức lưu thành câu cố định "Người dùng muốn được gọi là …"
  (`ADDRESS_PREFIX` trong memory.py). Mỗi lần dặn mới thì xoá câu cũ, nên chỉ giữ lần dặn sau cùng.
  Câu báo lỗi cố định không gọi "anh". Chữ trong app gọi trợ lý là "Gừng" và không gọi "anh";
  tên app và logo vẫn là "Ginger".

## Tài khoản theo thiết bị (backend/app/accounts.py)
- App sinh một UUID ngẫu nhiên lần đầu mở app. Native lưu nó trong Keychain, web lưu trong localStorage.
  App gửi kèm UUID này ở header `X-Device-Id` trong mọi request, vẫn cùng `APP_TOKEN` như cũ.
  Thiết bị lạ gọi tới lần đầu thì backend tạo tài khoản mới (bảng `users`, `devices`).
- Mọi dữ liệu theo tài khoản (`conversations.user_id`, `memories.user_id`, `users.chat_model`):
  - mọi truy vấn đều lọc theo `user_id`;
  - agent nhận `user_id` trong metadata dispatch từ `/livekit/token`.
- Ginger và Ginger Dev dùng chung nhóm Keychain `$(AppIdentifierPrefix)si.moca.troly.shared`
  (entitlement trong app.json). SecureStore không ghi access group, nên item rơi vào nhóm này.
  Vì vậy cùng một iPhone thì hai app là một tài khoản, và gỡ app cài lại vẫn giữ tài khoản.
- Dữ liệu có từ trước khi chia tài khoản có `user_id` NULL: không ai thấy cho tới khi gán tay.
  Settings hiện 8 ký tự đầu của mã thiết bị để tra trong bảng `devices`.
- Sau này đăng nhập Apple (iCloud): gắn nhiều `devices` vào cùng một `users.id`.

## Bộ nhớ 3 tầng (backend/app/memory.py)
1. Ngắn hạn: 20–29 tin gần nhất của cuộc trò chuyện hiện tại (cắt theo bậc 10 tin để prompt cache trúng)
2. Tóm tắt: mỗi cuộc có một bản tóm tắt, cập nhật sau mỗi 6 tin; đưa tóm tắt 3 cuộc gần nhất vào prompt
3. Dài hạn: sau mỗi lượt, Haiku trích các sự thật về người dùng → embed → lưu vào
   bảng `memories`. Ký ức có cosine ≥ 0.88 với ký ức cũ thì ghi đè lên ký ức cũ.
   Khi chat: tổng số ký ức ≤ 40 (`MEMORY_INLINE_MAX`) thì đưa hết vào prompt, không gọi Voyage
   (embedding câu hỏi mất 0,4–1,2s ngay trước Claude); nhiều hơn thì lấy top 8 ký ức liên quan.
Việc cập nhật bộ nhớ chạy trong BackgroundTask sau khi stream xong.

## Prompt caching (backend/app/llm.py)
Thứ tự prompt: system (persona + tóm tắt các cuộc trước, không đổi trong một cuộc)
→ lịch sử (mốc `cache_control` ở tin cuối) → tin mới nhất kèm khối `<ngữ_cảnh>`
(giờ hiện tại + ký ức liên quan). Không đưa thứ gì đổi theo lượt lên trước lịch sử.
Log `Claude usage: ...` để kiểm tra cache read/write.

## Tiến độ
- [x] Bước 1: backend chat stream + bộ nhớ. Đã test end-to-end trên Postgres thật,
      Claude/Voyage giả lập. Chưa gọi API thật.
- [x] Bước 2: app Expo có màn hình chat (stream qua `expo/fetch`), nút "Mới" và
      màn hình "Ký ức" để xem/xoá. Đã pass `tsc` và đóng gói Android được.
      Chưa chạy trên điện thoại thật.
- [x] Chạy thử với API key thật: `/chat` + trích ký ức chạy OK; app chạy trên iPhone qua Expo Go.
- [~] Bước 3: hold-to-talk. Đã bỏ UI chat text. `useAudioStream` (PCM int16 16 kHz) →
      WebSocket `/voice` → Soniox STT real-time (`stt-rt-v6`) → Claude + bộ nhớ →
      Soniox TTS (`tts-rt-v2`, mp3) → app phát qua `GET /voice/audio/{id}`.
      Đã test trọn vòng bằng script với key thật (giọng `Linh`); chưa thử trên điện thoại.
      Độ trễ sau khi thả nút (đo bằng script): transcript ~0,3s, chữ đầu ~1,6–2s,
      byte audio đầu ~2,6–3,2s. Đã có: TTS theo từng câu, phát dần mp3 khi Soniox đang
      tổng hợp (StreamingResponse), Claude tắt thinking + effort low, đóng STT chạy nền.
- [~] Bước 4, nấc 1 (rảnh tay, half-duplex): chạm mic = rảnh tay, giữ mic = hold-to-talk.
      Soniox `enable_endpoint_detection` chốt lượt (~0,3–0,4s sau khi ngừng nói); một
      WebSocket `/voice` nhiều lượt, sự kiện kèm `turn`; micro tắt khi Ginger nói, phát xong
      tự nghe tiếp; chạm mic lúc Ginger nói = ngắt lời; im 20s thì tự thoát.
      Đã test bằng script với key thật; chưa thử trên điện thoại.
- [~] Bước 4, nấc 2: ngắt lời bằng giọng qua LiveKit Cloud (anh đã chọn; có tài khoản Apple
      Developer để làm dev build). `backend/app/agent.py`: AgentSession với Soniox STT/TTS
      (plugin), chốt lượt bằng endpoint của Soniox (`turn_detection="stt"`, LiveKit chưa có
      turn detector tiếng Việt), Silero VAD cho ngắt lời, `llm_node` tự gọi Claude + bộ nhớ.
      Khi bị ngắt, lưu phần đã đọc; tin user liền nhau được gộp trong `llm.build_messages`.
      `POST /livekit/token` cấp token + dispatch agent `ginger`, conversation_id đi theo
      metadata. App: `src/LiveVoice.tsx` (dev build) / `src/ExpoGoVoice.tsx` (Expo Go, nấc 1),
      `App.tsx` chọn theo `Constants.executionEnvironment`.
      Đã test trọn vòng bằng client Python giả làm app (key LiveKit thật, region India South):
      hỏi → trả lời, nói chen vào → Ginger dừng (~1,1s), lưu phần đã đọc, trả lời câu mới.
      Chỉnh đã làm (đo được): STT `sample_rate=24000` khớp room_io (để 16k thì resampler giữ
      ~1s audio → chốt lượt chậm thêm 1,1s); `max_endpoint_delay_ms=500`; tắt language ID;
      ngắt lời mode "vad" (mode "adaptive" gọi LiveKit Cloud bị timeout 0,8s rồi mới rơi về VAD);
      `num_idle_processes=1`. `aec_warmup_duration` giữ mặc định 3s: chỉ khoá
      ngắt lời một lần mỗi phiên (câu trả lời đầu), đã thử 1s thì Ginger nghe nhầm tiếng
      mình vọng lại thành lời anh ("Dạ, em nghe đây") ở câu trả lời đầu tiên.
      Chưa build/thử trên iPhone.
- [~] Bản web (Safari, chờ Apple duyệt gói Developer): `LiveVoice.tsx` dùng chung, phần khác
      nhau nằm ở `src/livekit.tsx` / `src/livekit.web.tsx` và `src/config.ts` / `config.web.ts`.
      `npx expo export -p web` → `app/dist`, FastAPI mount ở `/` (cùng origin, không CORS).
      Token không đóng gói vào bản web: `TokenGate` hỏi một lần, lưu localStorage.
      Đã test trọn vòng bằng Chromium headless (micro giả từ file wav): hỏi → trả lời.
      HTTPS qua `tailscale serve` trên Windows. Anh đã dùng trên iPhone: ngắt lời bằng giọng OK.
- Ngắt lời mượt (`src/ducking.ts`): micro to hơn 3× ồn nền (ồn nền đo liên tục) trong 200ms
  là app hạ giọng Ginger xuống 25% trong ~0,2s; thôi nói 0,8s thì to lại. Server chỉ ngắt
  khi STT nghe ra ≥1 chữ (`min_words: 1`, để tiếng ồn không làm Ginger dừng rồi đọc tiếp);
  đo bằng Chromium + file ồn: ồn/lạch cạch không ngắt, nói chen trong ồn thì ngắt sau ~2s.
  Web cần `webAudioMix` (Safari iOS bỏ qua audio.volume) với AudioContext tạo ngay lúc chạm mic;
  âm lượng micro tính RMS tuyến tính (`useAudioLevel`) cho cùng thang với native.
- Cài đặt (`src/Settings.tsx`, nút bánh răng ở header, khoá khi đang trò chuyện): xoá ký ức /
  lịch sử / tất cả; bấm vào dòng "Ký ức của Gừng" mở trang danh sách ký ức, nút ✕ xoá từng điều (cho
  trường hợp Gừng nhớ nhầm). Mọi nút xoá đều mở popup hỏi lại (`ConfirmDialog`, tự vẽ bằng Modal vì Alert
  không chạy trên web). Đã test bằng DB tạm.
- Lọc tiếng vọng (`is_echo` + `Ginger.stt_node` trong agent.py): khử vọng của iPhone không
  triệt hết, STT vẫn nghe ra lời Ginger (sai dấu, cụt chữ, số đọc thành chữ số) rồi Ginger tự
  ngắt lời mình. Đoạn STT bắt đầu lúc Ginger đang nói (hoặc ≤1s sau) bị bỏ nếu ≥60% âm tiết
  (bỏ dấu) trùng theo đúng thứ tự (LCS) với câu Ginger vừa nói. Một âm tiết lẻ lúc đó cũng bỏ,
  trừ lời ngắt quen ("thôi", "dừng", "khoan"); bản tạm 1–2 âm tiết thì chờ thêm. Đánh đổi:
  "ừ", "có" nói ngay trong 1s sau khi Ginger dứt lời bị bỏ qua. Đo bằng client giả trộn 30%
  giọng Ginger ngược vào micro: Ginger nói liền 70s không tự ngắt (trước đó tự ngắt sau vài
  giây), chen "Thôi dừng lại" vẫn dừng.
- Lọc giọng xung quanh (công tắc trong Cài đặt, `users.voice_isolation`, mặc định tắt): agent bật
  Krisp voice isolation (`livekit-plugins-krisp`) ở đầu vào audio, bỏ giọng người khác / TV /
  karaoke, giữ giọng gần micro nhất. Có công tắc vì gói free LiveKit Cloud chỉ có 100 phút
  voice isolation/tháng (Ship $50: 1.000 phút); hết phút thì chưa rõ LiveKit xử lý ra sao.
  Áp dụng từ phiên sau. Đo bằng client giả: không thêm độ trễ (transcript ~0,8s), không mất đầu
  câu, lọc tiếng vọng và ngắt lời vẫn chạy. Chưa thử với karaoke thật.
- Gợi ý tên "Gừng" cho STT (`STT_CONTEXT` trong voice.py, agent dùng chung): không có gợi ý thì
  Soniox hay nghe "Gừng" thành "Dừng", "Rừng", "Hương", "Gương" (log thật: "Gương ơi", "Hương
  đang làm gì"; "Gừng ơi" trộn ồn → "Dừng ngay"). Đo bằng câu TTS trộn ồn: không gợi ý sai 4/6
  câu có "Gừng", có gợi ý đúng 6/6; "dừng lại", "đừng", "rừng", "mừng", "Hương" vẫn đúng, chỉ
  "Gương ơi" thành "Gừng ơi".
- Bắt đầu nhanh (web): agent vào phòng mất 3–5s (kết nối từ WSL tới LiveKit India South, đo
  bằng script riêng vẫn 3–4s; gọi agent bằng API dispatch còn chậm hơn ~2s nên không dùng).
  Bản web bật `preConnectBuffer`: micro thu ngay khi kết nối, app hiện "đang nghe" sau ~1s,
  agent vào thì nhận lại phần đã nói (Opus/webm; trình duyệt không ghi được webm thì tắt).
  Native không có MediaRecorder nên vẫn chờ agent. Agent không được gọi `ctx.connect()` trước
  `session.start` (sẽ lỡ bộ đệm). App báo lỗi nếu 15s chưa thấy agent.
  Đã test bằng Chromium: nói ngay khi chạm mic, agent vào sau 5s vẫn nghe đúng câu hỏi.
- Bản preview (`eas build --profile preview`, internal distribution, JS đóng gói sẵn): `app/.env`
  không lên EAS (gitignore), nên `EXPO_PUBLIC_API_URL` nằm ở biến môi trường EAS `preview`
  (không ghi vào eas.json vì repo public). Token không đóng gói: `TokenGate` hỏi một lần, lưu
  Keychain (`expo-secure-store`, nạp lười để dev build cũ không lỗi). Đổi địa chỉ backend thì
  `eas env:update` rồi build lại.
- Cập nhật qua mạng (EAS Update, `expo-updates`, channel `preview`): đổi JS/TS thì chạy
  `bash scripts/ota.sh "mô tả"` trong `app/`, không cần build lại; app preview tải bản mới khi mở,
  chạy bản đó từ lần mở sau. Thêm/nâng thư viện native hay đổi app.json thì vẫn phải build.
  `runtimeVersion` theo fingerprint, tính cả `scripts` trong package.json và `.gitignore`: sửa
  hai chỗ đó cũng phải build lại (script tự so với build preview mới nhất, lệch thì dừng).
  Không chạy thẳng `eas update`: nó đóng gói trên máy và đọc `app/.env` nên nhúng
  `EXPO_PUBLIC_APP_TOKEN` vào bản update (đã thử). `scripts/ota.sh` tắt .env (`EXPO_NO_DOTENV=1`),
  lấy biến từ môi trường EAS `preview`, kiểm tra bundle không có token rồi mới tải lên.
- Bản App Store/TestFlight: build trên MacBook của anh bằng `bash scripts/build-ios.sh` (trong `app/`,
  `eas build --local`, profile `production`, không tốn lượt EAS; gói Free chỉ có 15 build iOS/tháng).
  Script pull code, build .ipa vào `~/ginger-ipa`, soi bundle (có API URL, không có token) rồi
  `eas submit`, rồi lưu runtime của bản đó vào biến EAS `TESTFLIGHT_RUNTIME` (môi trường `production`) để
  `ota.sh` trên PC (không có .ipa) biết đẩy OTA tới bản TestFlight được không (`--record`: chỉ lưu). Không build bằng Xcode tay (Metro đọc app/.env → nhúng token). Profile `production` dùng
  channel `preview` nên OTA tới cả bản TestFlight; eas.json không tính vào fingerprint.
  Đưa ra ngoài TestFlight nội bộ thì người duyệt Apple vướng `TokenGate`.
- Tự rảnh tay (native): mở app hoặc quay lại app (AppState 'active') là tự bắt đầu trò chuyện,
  sang app khác ('background') thì kết thúc. Web vẫn phải chạm mic (Safari cần chạm mới phát
  được âm thanh). Chuyển từ chế độ gõ chữ về thì không tự bắt đầu.
- Lúc vào phòng (`phase` 'connecting' trong LiveVoice.tsx): 3 thanh vàng chung đáy nhấp nhô qua lại
  kiểu boomerang (`ConnectingBars`, đổi chiều cao thật để giữ đầu bo tròn), nút micro mờ, không dùng chữ. Phải khác hẳn quả cầu "đang nghĩ", vì native
  không có bộ đệm trước khi agent vào: anh tưởng Gừng đang nghe mà nói luôn thì mất đoạn đó.
  Agent báo 'listening' ngay khi vào phòng nhưng audio micro còn 1–3s nữa mới tới (LiveKit đưa
  khung toàn số 0, nói gì cũng mất): agent đặt attribute `mic_ready` khi khung khác 0 đầu tiên tới
  (`Ginger._watch_mic`, sau 6s vẫn chưa có thì vẫn đặt), app giữ 'connecting' tới lúc đó.
  Đo bằng client giả nói ngay khi sẵn sàng: trước mất nửa đầu câu, sau nghe đủ.
  Hết 'connecting' thì rung nhẹ (`expo-haptics`, nạp lười để dev build cũ không lỗi).
  LiveVoice chỉ có một cây `Layout`; phòng LiveKit là con không vẽ gì, báo trạng thái lên qua
  `onState`. Vẽ Layout riêng trong phòng thì lúc vào phòng React dựng lại: icon header và
  hiệu ứng kết nối nháy.
- Nút tắt micro (`MuteButton` trong ui.tsx, bên trái nút micro, chỉ hiện khi đã vào phòng; hai nút bên chỉ có icon, cách nút micro `SIDE_GAP` để nằm ngoài quầng sáng lúc phồng to nhất): `setMicrophoneEnabled(false)`
  (tắt track, không rời phòng), vẫn nghe Gừng nói; nút luôn là icon micro gạch chéo (khác nút micro giữa), bình thường chỉ có icon đỏ cam (không vòng tròn, vùng bấm giữ nguyên), đang tắt thì nền tròn đỏ cam, icon trắng; không có dòng chữ báo tắt micro. Bắt đầu lại
  thì micro bật. Agent vẫn tính im lặng như thường: tắt quá 20s thì phiên tự kết thúc. Chưa thử trên iPhone.
- Nút dừng (`StopButton`, bên phải nút micro, đối xứng nút tắt micro; chỉ bấm được lúc Gừng đang nói / đang nghĩ; bấm được thì nền tròn nâu đậm, icon vuông trắng; chưa bấm được thì chỉ icon vuông nâu trơn, mờ):
  app tắt tiếng track của Gừng ngay (`useDucking(..., silenced)`) và gọi RPC `stop_speaking` tới agent →
  `session.interrupt(force=True)` (cả câu đọc kết quả việc nền), phần đã đọc vẫn lưu, phiên không kết thúc; agent quay
  về nghe thì app bật lại tiếng. Chưa thử với LiveKit thật.
- Câu còn dở (`looks_incomplete` + `Ginger.stt_node` trong agent.py): Soniox chốt lượt sau ~0,5s im, anh ngập
  ngừng là câu vỡ thành nhiều tin ("Thì." "Cái." "Trong." "Game."), Gừng trả lời chen rồi bị ngắt (log thật: 6/15
  lần gọi Claude bị bỏ). Đoạn STT vừa chốt mà dừng ở chữ nối (là, thì, của, trong…), toàn tiếng đệm (à, ờ), có
  dấu phẩy cuối, hoặc mẩu cuối chỉ 1–2 chữ không nằm trong danh sách câu ngắn trọn vẹn (có, không, đúng rồi,
  thôi, bao nhiêu…) thì đặt `min_delay` 2,0s thay vì 0 (`session.update_options` ngay trước khi đưa
  END_OF_SPEECH cho LiveKit); nói tiếp trong lúc chờ là LiveKit huỷ lượt chốt và gộp câu. So chữ giữ nguyên dấu.
  Đo bằng client giả nói "Anh muốn hỏi là / à / thủ đô của / nước Úc là thành phố nào?" cách 0,7–0,9s: trước
  4 tin + Gừng chen; 1,5s vẫn tách; 2,0s: một lần gộp trọn 1 tin, một lần 2 tin (Soniox cắt "À, thủ đô." trông
  như câu trọn). Câu trọn bị nhận nhầm là dở thì chậm thêm ~1,2s.
- Tắt DTX cho track giọng Ginger (`AudioOutputOptions` trong agent.py): để DTX thì hễ im là agent
  chỉ gửi gói tiếng ồn nền (50 → 4 gói/giây) và iPhone kêu "bụp" ngay khi dứt chữ cuối. Âm Soniox
  và âm nhận qua LiveKit đều kết thúc sạch (đã đo).
- Độ trễ mỗi lượt nói: trung vị ~3,0s (từ 3,8s, nhờ bỏ Voyage khỏi đường nóng). Chi tiết từng
  chặng, những gì đã thử không ăn thua và các hướng còn lại (kèm đánh đổi): `docs/do-tre.md`.
- Chế độ gõ chữ (`src/ChatScreen.tsx`, nút bàn phím ở góc trái header; nút micro để quay lại):
  stream qua `POST /chat`. Hai chế độ dùng chung cuộc trò chuyện (`src/conversation.ts`),
  mở chat thì tải lại tin của cuộc đang mở (cả lượt nói). Web: Enter gửi, Shift+Enter xuống dòng.
  Chỗ trống dưới khung nhập chữ theo bàn phím bằng `react-native-keyboard-controller` (`src/keyboard.tsx`,
  chạy trên UI thread nên lên cùng nhịp bàn phím; `Animated.spring` theo `keyboardWillShow` thì lên chậm hơn).
  Đang trả lời thì nút gửi thành nút dừng (AbortController); backend vẫn lưu phần đã trả lời
  (uvicorn báo ASGI 2.3 nên Starlette huỷ stream rồi vẫn chạy BackgroundTask).
  Đã test bằng Chromium với Claude thật.
      Cân nhắc LiveKit (có SDK React Native + agent Python) để xử lý chống vọng tiếng.

## Môi trường dev
- Code chạy trong WSL trên Windows
- Điện thoại thường không vào thẳng được IP của WSL:
  - Expo: chạy `npx expo start --tunnel`
  - Backend: mở port 8000 bằng WSL mirrored networking, hoặc `netsh interface portproxy`
- Postgres chạy bằng `docker.exe compose up -d` (Docker Desktop, chưa bật WSL integration). Mật khẩu là chuỗi ngẫu nhiên
  `POSTGRES_PASSWORD` trong `backend/.env` (compose tự đọc, phải khớp `DATABASE_URL`), cổng chỉ mở trên 127.0.0.1
- Điện thoại gọi backend qua Tailscale Funnel (HTTPS công khai, dev build bị ATS chặn http):
  `EXPO_PUBLIC_API_URL=https://<máy>.<tailnet>.ts.net` (`tailscale funnel --bg 8000` trên Windows;
  điện thoại không cần cài Tailscale). Backend mở ra Internet nên `APP_TOKEN` là lớp bảo vệ duy nhất:
  mọi route trừ `/health` và bản web tĩnh phải qua `token_ok` (so bằng `secrets.compare_digest`)
  (giá trị thật nằm trong `app/.env`),
  Windows `netsh portproxy` 8000 → IP WSL (đổi sau mỗi lần reboot)
- Expo CLI đăng nhập bằng `EXPO_TOKEN` trong `~/.zshrc`; chạy `npx expo start --tunnel`
  (dev build: thêm `--dev-client`)
- Tự khởi động sau khi bật máy (`scripts/autostart/install.sh`, chạy một lần): backend, agent, worker trình
  duyệt và worker sửa code là dịch vụ systemd user `ginger-backend` / `ginger-agent` / `ginger-browser` / `ginger-dev` (linger, tự chạy lại khi chết); task Windows
  "Ginger" lúc đăng nhập giữ WSL chạy và trỏ portproxy 8000 sang IP WSL mới; Postgres
  `restart: unless-stopped`, Docker Desktop tự mở (lên sau WSL nên `init_db` chờ Postgres tối đa 3 phút;
  uvicorn `--reload` giữ process cha khi app lỗi khởi động, systemd không biết mà chạy lại). Sửa agent.py thì `systemctl --user restart
  ginger-agent`; log: `journalctl --user -u ginger-agent`. Muốn chạy tay thì `systemctl --user stop` trước.
- Agent LiveKit: `python -m app.agent dev` (process riêng, cạnh uvicorn); cần `LIVEKIT_URL`,
  `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` trong `backend/.env` — anh tự điền.
- API key (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SONIOX_API_KEY`) do anh tự điền vào `backend/.env`.
  Không tự điền hay in key ra.

## Quy ước
- Expo: luôn dùng `npx expo install`; tra docs đúng phiên bản SDK (xem app/AGENTS.md)
- Chạy `npx tsc --noEmit` và `npx expo lint` trước khi báo xong. `expo lint` chỉ quét
  `src/` (không quét App.tsx ở gốc) nên code màn hình đặt trong `src/`.
- UI và prompt viết bằng tiếng Việt
