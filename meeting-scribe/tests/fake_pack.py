"""測試用的假擴充包（#97）：在暫存資料夾產生 pack.json、提示詞、會議紀錄模板和一份小型 Word 範本。
本體的測試只用這個，不依賴任何客製的範本（例如某縣市的 IEP 會議紀錄，放在自己的擴充包）。

範本有兩種會議，用分頁符號隔開：
- 「測試擬訂會議」：報告事項（三段說明＋一組勾選）、會議決議有大項標題。
- 「測試結束會議」：會議決議沒有大項標題，三擇一直接寫在格子裡（decision_anchor）。
"""
import json
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
      'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"')
FONT = '<w:rPr><w:rFonts w:ascii="標楷體" w:eastAsia="標楷體"/></w:rPr>'


def run(text, under=False):
    rpr = '<w:rPr><w:rFonts w:ascii="標楷體" w:eastAsia="標楷體"/><w:u w:val="single"/></w:rPr>' if under else FONT
    return f'<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def para(*parts, page_break=False):
    """parts：字串是一般字，("u", n) 是 n 格帶底線的空白（表頭空格）。"""
    runs = '<w:r><w:br w:type="page"/></w:r>' if page_break else ""
    for x in parts:
        runs += run(" " * x[1], True) if isinstance(x, tuple) else run(x)
    return f'<w:p w14:paraId="00000001">{runs}</w:p>'


def cell(*paras):
    return f'<w:tc><w:tcPr><w:tcW w:w="9000" w:type="dxa"/></w:tcPr>{"".join(paras) or para()}</w:tc>'


def table(*rows):
    return "<w:tbl><w:tblPr/>" + "".join(f"<w:tr>{''.join(r)}</w:tr>" for r in rows) + "</w:tbl>"


def header(title):
    return [
        para("測試縣", ("u", 5), "學校", ("u", 4), "學年度第", ("u", 2), f"學期 {title}", page_break=title == "測試結束會議"),
        para(("u", 3), "年", ("u", 3), "班，學生姓名：", ("u", 8), " 會議日期：", ("u", 3), "年", ("u", 2), "月", ("u", 2), "日"),
        para("地點：", ("u", 6), " 主席：", ("u", 6), " 記錄者：", ("u", 6)),
        table([cell(para("與會者簽名"))], [cell(para("行政人員")), cell(para("家長"))], [cell(), cell()]),
        para(),
    ]


REPORT = [para("學生本人說明自己的學習："), para(), para("家長的觀察與期望："), para(), para("導師的觀察："), para(),
          para("討論事項", "（依個案需求勾選；有具體討論請簡略摘要）", "："), para("□能力現況："), para(),
          para("□行為功能介入："), para(), para("□轉銜服務："), para()]
CONSENT = table([cell(para("本人已詳細閱讀，並同意這份計畫的執行！"), para("家長簽名："))])


def document_xml():
    plan = header("測試擬訂會議") + [
        table([cell(para("會議紀錄"))], [cell(para("報告事項及討論內容"))], [cell(*REPORT)]),
        para(),
        table([cell(para("會議決議"))],
              [cell(para("學習內容："), para("□語文-國（抽離/外加", ("u", 3), "節）"), para("□數學"), para("□特殊需求："),
                    para("評量調整："), para("□評量時間調整：○延長考試時間20分鐘 ○其他："), para("□試題調整：○試題報讀 ○其他："),
                    para("相關服務："), para("□相關專業人員服務申請：○職能治療 ○巡迴輔導"), para("□家庭支持服務"),
                    para("□人力資源：○酌減班級人數"), para("其他："), para())],
              [cell(CONSENT, para())]),
        para(),
    ]
    exit_ = header("測試結束會議") + [
        table([cell(para("會議紀錄"))], [cell(para("報告事項及討論內容"))], [cell(*REPORT)],
              [cell(para("會議決議"))], [cell(para("□結束特殊教育服務"), para("□持續接受特殊教育服務"))], [cell(CONSENT, para())]),
    ]
    body = "".join(plan + exit_) + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>'
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document {NS}><w:body>{body}</w:body></w:document>'


CONTENT_TYPES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                 '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                 '<Default Extension="xml" ContentType="application/xml"/>'
                 '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                 '</Types>')
RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '</Relationships>')

PROMPT = """會議結束了，這是一場「{title}」，日期 {date}（星期{weekday}）。請依逐字稿填表。只輸出一個 JSON 物件：
{"header": {"name": "學生姓名"}, "items": {"<欄位 id>": {"on": true}}}
表上的欄位（id：說明）：
{fields}
"""

AGENDA_PROMPT = """開會前準備「{title}」，日期 {date}（星期{weekday}）。依學生資料把議程每一項寫成提問。只輸出 JSON：
{"facts": {"grade": 6, "class": "甲"}, "items": {"<id>": "提問"}, "extra": [{"title": "", "detail": ""}]}
議程項目（id：說明）：
{items}
學生資料：
{student}
"""

PERIOD = {"choose": ["抽離", "外加"], "blanks": [{"id": "periods", "label": "節數", "fmt": "{} 節"}]}
OTHER = {"label": "其他", "blank": True, "fmt": "其他：{}"}
HEADER = [
    {"id": "school", "label": "學校", "after": "測試縣"}, {"id": "year", "label": "學年度", "after": "學校"},
    {"id": "term", "label": "學期", "after": "第"}, {"id": "grade", "label": "年級", "after": None},
    {"id": "class", "label": "班級", "after": "年"}, {"id": "name", "label": "學生姓名", "after": "學生姓名："},
    {"id": "date_y", "label": "會議日期：年（民國）", "after": "會議日期："}, {"id": "date_m", "label": "月", "after": "年"},
    {"id": "date_d", "label": "日", "after": "月"}, {"id": "place", "label": "地點", "after": "地點："},
    {"id": "chair", "label": "主席", "after": "主席："}, {"id": "recorder", "label": "記錄者", "after": "記錄者："},
]
REPORT_GROUPS = [
    {"title": "報告事項", "heading": None, "items": [
        {"kind": "text", "id": "student", "label": "學生本人說明", "find": "學生本人說明"},
        {"kind": "text", "id": "parent", "label": "家長的觀察與期望", "find": "家長的觀察"},
        {"kind": "text", "id": "teacher", "label": "導師的觀察", "find": "導師的觀察"}]},
    {"title": "討論事項", "heading": "討論事項", "items": [
        {"kind": "check", "id": "ability", "label": "能力現況", "text": True},
        {"kind": "check", "id": "behavior", "label": "行為功能介入", "text": True},
        {"kind": "check", "id": "transition", "label": "轉銜服務", "text": True}]},
]
PACK = {
    "id": "test-pack", "title": "測試擴充包", "forms_title": "測試會議紀錄（簽名版）",
    "minutes_templates": [{"id": "test-teacher", "file": "minutes/test-teacher.md"}],
    "modules": [{"id": "test-module", "title": "測試模組", "description": "擴充包帶的模組", "prompt": "prompts/module.md",
                 "options": [{"id": "tone", "label": "語氣", "choices": [
                     {"id": "warm", "label": "溫和", "prompt": "溫和的同事"}, {"id": "strict", "label": "嚴格", "prompt": "嚴格的督學"}]}]}],
    "agendas": [
        {"id": "test-agenda", "title": "測試擬訂議程", "form": "test-plan", "prompt": "prompts/agenda.md",
         "student_files": ["profile.md", {"glob": "reports/*-minutes.md", "latest": 1}],
         "items": [
             {"id": "student", "title": "學生本人說明", "detail": "可用圖卡", "required": True, "form_item": "student"},
             {"id": "parent", "title": "家長的觀察與期望", "required": True, "form_item": "parent"},
             {"id": "behavior", "title": "行為功能介入", "detail": "不需要也要說理由", "required": True, "form_item": "behavior"},
             {"id": "transition", "title": "轉銜服務", "required": True, "form_item": "transition", "when": [{"grade_in": [2, 4, 6]}]},
             {"id": "emotion", "title": "情緒行為支持", "when": [{"text_has": ["情緒", "自閉"]}]},
         ]},
        {"id": "test-free", "title": "沒有學生資料的議程", "items": [{"id": "a", "title": "第一項", "required": True}]},
    ],
    "shared": {
        "header": HEADER,
        "header_defaults": {"school": "remember", "year": "roc_school_year", "term": "school_term",
                            "date_y": "roc_year", "date_m": "month", "date_d": "day", "place": "meeting_place"},
    },
    "forms": [
        {"id": "test-plan", "title": "測試擬訂會議", "docx": "forms/test.docx", "prompt": "prompts/form.md",
         "section": {"marker": "測試擬訂會議"}, "header": "@header", "header_defaults": "@header_defaults",
         "report": REPORT_GROUPS,
         "decisions": [
             {"title": "學習內容", "heading": "學習內容：", "items": [
                 {"kind": "check", "id": "chinese", "label": "語文-國", **PERIOD},
                 {"kind": "check", "id": "math", "label": "數學", **PERIOD},
                 {"kind": "check", "id": "special", "label": "特殊需求", "blanks": [
                     {"id": "name", "label": "課程", "fmt": "{}"}, {"id": "domain", "label": "融入領域", "fmt": "融入{}領域"}]}]},
             {"title": "評量調整", "heading": "評量調整：", "items": [
                 {"kind": "check", "id": "exam_time", "label": "評量時間調整", "options": [{"label": "延長考試時間20分鐘"}, OTHER]},
                 {"kind": "check", "id": "exam_paper", "label": "試題調整", "options": [{"label": "試題報讀"}, OTHER]}]},
             {"title": "相關服務", "heading": "相關服務：", "items": [
                 {"kind": "check", "id": "pro", "label": "相關專業人員服務申請", "options": [
                     {"label": "職能治療"}, {"label": "巡迴輔導", "choose": ["不分類", "情緒行為"], "fmt": "巡迴輔導（{}）"}]},
                 {"kind": "check", "id": "family", "label": "家庭支持服務"},
                 {"kind": "check", "id": "staff", "label": "人力資源", "options": [
                     {"label": "酌減班級人數", "blank": True, "fmt": "酌減班級人數 {} 人"}]}]},
             {"title": "其他", "heading": "其他：", "items": [{"kind": "text", "id": "decision_other", "label": "其他", "find": "其他："}]},
         ],
         "warnings": [
             {"when": [{"empty": "teacher"}], "text": "「導師的觀察」還沒寫"},
             {"when": [{"off": "behavior"}], "text": "行為功能介入：不需要也要寫理由"},
             {"when": [{"off": "transition"}, {"grade_in": [2, 4, 6]}], "text": "轉銜：{grade} 年級要寫轉銜服務"},
         ],
         "file_name": "測試擬訂會議紀錄", "drive_file": "test-minutes.docx"},
        {"id": "test-exit", "title": "測試結束會議", "docx": "forms/test.docx", "prompt": "prompts/form.md",
         "section": {"marker": "測試結束會議"}, "header": "@header", "header_defaults": "@header_defaults",
         "report": REPORT_GROUPS,
         "decisions": [{"title": "會議決議", "heading": None, "items": [
             {"kind": "check", "id": "exit_end", "label": "結束特殊教育服務。"},
             {"kind": "check", "id": "exit_keep", "label": "持續接受特殊教育服務。"}]}],
         "decision_anchor": "結束特殊教育服務",
         "warnings": [{"when": [{"off": "transition"}], "text": "轉銜：結束前要寫轉銜服務"}],
         "file_name": "測試結束會議紀錄", "drive_file": "test-minutes.docx"},
    ],
}


def make_pack(root, pack=None):
    """在 root 產生假擴充包，回傳資料夾路徑。pack 可以傳改過的 pack.json 內容（測試錯誤格式用）。"""
    root = Path(root)
    (root / "forms").mkdir(parents=True, exist_ok=True)
    (root / "prompts").mkdir(exist_ok=True)
    (root / "minutes").mkdir(exist_ok=True)
    with zipfile.ZipFile(root / "forms" / "test.docx", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", document_xml())
    (root / "prompts" / "form.md").write_text(PROMPT, encoding="utf-8")
    (root / "minutes" / "test-teacher.md").write_text("# 測試教師版\n\n- summary：三句以內。\n", encoding="utf-8")
    (root / "prompts" / "agenda.md").write_text(AGENDA_PROMPT, encoding="utf-8")
    (root / "prompts" / "module.md").write_text("測試模組的指示\n<role>\n{tone}\n</role>\n", encoding="utf-8")
    (root / "pack.json").write_text(json.dumps(pack or PACK, ensure_ascii=False, indent=1), encoding="utf-8")
    return root


def make_students(root):
    """假學生資料夾：s-001 有六年級、情緒的資料和兩次會議紀錄；s-002 幾乎空白；_inbox 要被略過；
    s-001 裡有一個指到外面的符號連結，不能被讀到。"""
    root = Path(root)
    a = root / "s-001"
    (a / "reports").mkdir(parents=True, exist_ok=True)
    (a / "profile.md").write_text("# s-001\n- 115：六甲\n- 醫療：情緒障礙\n- 鑑輔有效至 115.10.01\n", encoding="utf-8")
    (a / "reports" / "2026-01-22-minutes.md").write_text("舊的會議紀錄：不該讀到\n", encoding="utf-8")
    (a / "reports" / "2026-06-25-minutes.md").write_text("上次決議：數學抽離 4 節\n", encoding="utf-8")
    outside = root.parent / "outside-secret.md"
    outside.write_text("外面的秘密", encoding="utf-8")
    try:
        (a / "reports" / "2026-12-31-minutes.md").symlink_to(outside)
    except FileExistsError:
        pass
    # 選單上的名字（config students_label）：s-001 有 README 標題；s-002 沒有 README，用代碼
    (a / "README.md").write_text("---\nstudent_code: s-001\n---\n# 王〇安（s-001）\n\n# 第二個標題不算\n", encoding="utf-8")
    (root / "s-002").mkdir(exist_ok=True)
    (root / "s-002" / "profile.md").write_text("# s-002\n", encoding="utf-8")
    (root / "_inbox").mkdir(exist_ok=True)
    return root
