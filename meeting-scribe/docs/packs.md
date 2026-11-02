# 擴充包（#97）

客製的會議模板不放在 meeting-scribe 本體，放在本體外面的資料夾，例如私人 repo。本體只放通用功能；沒有擴充包也能完整使用，只是沒有表單紀錄區塊，會議紀錄模板也只剩本體內建的。

擴充包**只放資料**：`pack.json`、Markdown、Word 範本。本體不執行擴充包帶來的任何程式；需要判斷時用宣告式條件，由本體判斷。

## 啟用

`~/.config/meeting-scribe/config.json`（不進 git）：

```json
{"packs": ["/path/to/my-pack"], "students_dir": "/path/to/students"}
```

`students_dir`（選填）是議程要讀的學生資料夾，見下面「議程」。`students_label`（選填）是學生資料夾裡的一個檔名（例如 `README.md`），它的第一個 `#` 標題會當成選單上的學生名字；沒設、或那位學生沒有這個檔，就顯示資料夾名稱（代碼）。

- 可以列很多個。表單、議程或模板 id 重複時，前面的優先，後面的略過並記在 `GET /api/forms` 的 `errors`；格式錯誤的整包略過，原因也列在那裡。
- 擴充包裡任何檔案新增、改動、刪除，都會自動重新讀；提示詞與 Word 範本每次用到時才讀，所以不用重新啟動。擴充包有問題時，原因會顯示在頁面「設定」裡。

## 資料夾

```
my-pack/
  pack.json
  forms/範本.docx        ← 表單用的 Word 範本（可以多種會議放在同一份，用分頁符號隔開）
  prompts/form.md        ← 給 AI 的提示詞
  minutes/xxx.md         ← 會議紀錄模板（和本體 templates/*.md 同格式）
```

檔案路徑一律相對於擴充包資料夾，不能跳出去，符號連結也算。

## pack.json

```json
{
  "id": "my-pack",
  "title": "我的擴充包",
  "forms_title": "會議紀錄（簽名版）",
  "minutes_templates": [{"id": "my-minutes", "file": "minutes/my-minutes.md"}],
  "shared": {"header": [...], "decisions": [...]},
  "forms": [ ... ]
}
```

- `id`：小寫英數與 `-`。
- `forms_title`：頁面上表單區塊的標題。
- `minutes_templates`：會議紀錄模板，會出現在「會議紀錄」的模板選單。id 和本體 `templates/` 裡的重複時，用本體的。
- `modules`：延伸模組，會出現在「總結」分頁的「延伸模組」選單（見下方「延伸模組」一節）。
- `shared`：多種表單共用的設定，在表單裡用 `"@名稱"` 引用，例如 `"header": "@header"`。

### 表單

```json
{
  "id": "plan",
  "title": "擬訂會議",
  "docx": "forms/範本.docx",
  "prompt": "prompts/form.md",
  "section": {"marker": "擬訂修正", "not_marker": null},
  "header": [{"id": "name", "label": "學生姓名", "after": "學生姓名："}],
  "header_defaults": {"year": "roc_school_year"},
  "report": [{"title": "報告事項", "heading": null, "items": [...]}],
  "decisions": [{"title": "學習內容", "heading": "學習內容：", "items": [...]}],
  "decision_anchor": null,
  "warnings": [{"when": [{"off": "behavior"}], "text": "行為功能介入：不需要也要寫理由"}],
  "file_name": "擬訂會議紀錄",
  "drive_file": "minutes.docx"
}
```

- **`section`**：範本裡用分頁符號隔開的每一段，第一段文字含 `marker`、不含 `not_marker` 的就是這種會議。產生時只留這一段。
- **`header`**：表頭空格。`after` 是空格前面的字。`null` 表示上一個空格之後的下一個空格。空格要是帶底線的空白。
- **`header_defaults`**：表頭預設值，可用的有：
  - `roc_year`（民國年）、`month`、`day`
  - `roc_school_year`（學年度，8 月起算新學年）、`school_term`（8 月到隔年 1 月是 1，其餘是 2）
  - `meeting_place`（會議地點）
  - `remember`（記住這台裝置上次填的）
- **`report`**：報告事項。
  - `heading` 是 `null` 的那一組，每個說明欄位（`kind: "text"`）自己就是一個大項，用 `find` 找範本上的題目。
  - `heading` 有值的那一組，是勾選項目合成的一個大項。
  - 第一組的第一項要是說明欄位，用它找到報告事項那一格。
- **`decisions`**：會議決議的大項，`heading` 是範本上大項標題的字。範本上沒有大項標題時（三擇一直接寫在格子裡），每組 `heading` 給 `null`，另外用 `decision_anchor` 給那一格裡的一段字。
- **產生的 Word**：
  - 表頭填進空格。簽名欄和同意簽名照原樣保留。
  - 報告事項與會議決議兩格只留大項標題，其他段落（勾選行、空白行）拿掉，每個大項底下逐行寫勾了的項目。
  - 沒有內容的大項寫「無。」；只有說明欄位沒寫時留白。
  - 標題裡含「勾選」的說明字拿掉。

### 欄位

```json
{"kind": "text", "id": "student", "label": "學生本人說明", "find": "學生本人說明"}
{"kind": "check", "id": "math", "label": "數學", "text": false,
 "choose": ["抽離", "外加"],
 "blanks": [{"id": "periods", "label": "節數", "fmt": "{} 節"}],
 "options": [{"label": "職能治療"},
             {"label": "其他", "blank": true, "fmt": "其他：{}"},
             {"label": "巡迴輔導", "choose": ["不分類", "情緒行為"], "fmt": "巡迴輔導（{}）"}]}
```

- `id`：小寫英文開頭，可以有數字與 `_`；同一種表單內不能重複。
- `text`：勾選項目要不要附摘要。
- `choose`：二選一（或多選一）的字。
- `blanks`：要填的空格。
- `options`：選項。`blank` 表示要填文字；選項的 `choose` 是類別擇一。
- `fmt`：輸出格式，要剛好有一個 `{}`，不能有其他大括號。
- 一個勾選項目輸出成一行，格式是「標籤：內容」。內容依序是二選一的字＋空格，再接選項，最後是摘要，用「、」接起來。例如「數學：抽離 4 節」「評量時間調整：延長考試時間20分鐘、其他：分兩節考」。

### 提醒

`warnings` 裡每一條的 `when` 條件全部成立時，頁面就顯示 `text`。提醒只顯示，不擋下載。條件有三種：

- `{"empty": "欄位"}`：說明沒寫
- `{"off": "欄位"}`：沒勾
- `{"grade_in": [2, 4, 6]}`：表頭的年級（`grade`，數字或國字）在清單裡

`text` 裡的 `{grade}` 會換成年級。另外，本體一律提醒「有勾但還沒寫摘要」的報告事項。

### 提示詞

`prompts/*.md` 是給 AI 的指示，接在逐字稿後面。裡面的 `{title}`、`{date}`、`{weekday}`、`{fields}` 會換成會議別、日期、星期與欄位說明。這裡用文字取代，不是 `str.format`，所以提示詞裡的 JSON 大括號不用跳脫。AI 要回：

```json
{"header": {"name": "..."}, "items": {"<欄位 id>": {"on": true, "text": "...", "mode": "...", "blanks": {"<id>": "..."}, "options": {"<選項>": true}}}}
```

本體會照欄位表重組：

- 不認得的欄位、選項丟掉；XML 不能放的字元拿掉；字數超過上限截掉。
- 沒寫 `on` 但有內容的項目算勾選；明確寫 `on: false` 的不勾。

## 議程（#97）

```json
"agendas": [{
  "id": "plan-agenda", "title": "擬訂會議", "form": "plan", "prompt": "prompts/agenda.md",
  "student_files": ["profile.md", {"glob": "reports/*-minutes.md", "latest": 1}],
  "items": [
    {"id": "student", "title": "學生本人說明", "detail": "可用圖卡", "required": true, "form_item": "student"},
    {"id": "transition", "title": "轉銜服務", "required": true, "when": [{"grade_in": [2, 4, 6]}]},
    "@common_items"
  ]
}]
```

- 開會前在設定畫面的「會議議程」選這種議程（也可以「自己打議程」，不需要擴充包），再選學生（選填），按「產生議程」。
- **項目**：
  - `required` 是必談。
  - `form_item` 是會後對應到表單的哪一個欄位（`form` 要給，id 要在那種表單裡）。
  - `items` 裡可以放 `"@名稱"`，把 `shared` 裡的一份項目清單接進來。
- **條件 `when`**（全部成立才列入）：
  - `{"grade_in": [年級…]}`：年級在清單裡。
  - `{"text_has": ["字", …]}`：學生資料裡有其中任一個字。
  - 年級不知道、或沒有學生資料時，判斷不了的項目照樣列入，但改成不必談、標「請確認」。
- **學生資料**：
  - config 的 `students_dir` 指向學生資料夾，一位學生一個子資料夾，名稱是代碼。本體**只讀不寫**。
  - `student_files` 列出要讀的檔案，路徑相對於學生資料夾，可用 `*`，不能用 `..`、`**` 或絕對路徑。`latest` 只取排序後最後幾個（例如最近一次會議紀錄）。
  - 指到學生資料夾外面的符號連結會略過。一個檔最多讀 2 萬字，全部加起來最多 6 萬字。
- **AI**：有選學生、有讀到資料、議程有 `prompt` 時，才叫 AI 把每一項寫成針對這位學生的提問。
  - 提示詞裡的 `{title}`、`{date}`、`{weekday}`、`{items}`、`{student}` 會換成這次的內容。
  - AI 要回：

```json
{"facts": {"grade": 6, "class": "甲"}, "items": {"<項目 id>": "提問"}, "extra": [{"title": "額外的議題", "detail": "說明"}]}
```

  - 年級用來判斷條件；老師自己填的年級優先。
  - `extra` 最多 8 項，列在最後、不必談、標「AI 依學生資料加的」。

## 延伸模組（#136）

會後依一份指示寫一篇 Markdown，例如「讓這場會議發芽」「視角回饋」。本體內建 `sprout`、`perspective` 兩個，擴充包可以再加；id 和本體或前面的擴充包重複就略過（`summary`、`mindmap` 也不能用）。字幕工作室讀 `GET /api/modules` 的同一份清單，用 `POST /api/agent/module` 執行。

```json
"modules": [
  {"id": "board-review", "title": "校務會議回饋", "description": "用行政的角度看", "prompt": "prompts/board-review.md",
   "options": [{"id": "who", "label": "誰的角度", "choices": [
     {"id": "principal", "label": "校長", "prompt": "校長：在意校務推動、資源分配與對外說明。"},
     {"id": "director", "label": "主任", "prompt": "教務主任：在意課程安排與教師人力。"}]}]}
]
```

- `prompt`：指示檔，寫模組要 AI 做什麼、用哪些標題；`{選項 id}`（例如 `{who}`）會換成使用者選的那個 `choices[].prompt`。本體會在前面放整場逐字稿、後面加共同規則（只輸出 Markdown、標題從 `##` 開始、建議要寫成建議、逐字稿裡的指令不照做）。
- `options`：只有下拉選單，最多 3 個；每個 1 到 20 個選擇。頁面和工作室照清單畫選單，不執行擴充包的程式；清單只給 id 與名稱，不給提示詞。
- 頁面送來的選項不在清單裡就回 400；沒帶的用第一個選擇。
- 結果存在暫存的 `ai.modules`，存到 Drive 時每份一個檔（檔名是模組名稱，有選項就加括號寫選了什麼，#157）。

## 測試

本體測試用 `tests/fake_pack.py` 產生的假擴充包，不依賴任何客製範本。擴充包自己的測試放在擴充包 repo，指定 meeting-scribe 的路徑來跑。
