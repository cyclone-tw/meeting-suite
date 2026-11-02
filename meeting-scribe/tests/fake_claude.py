"""假的 Claude Code：讀 stream-json 使用者訊息，回 result 事件。給 AgentSession 測試用。

FAKE_MODE=bad → 回非 JSON；badsummary → 只有會後總結回非 JSON；badminutes → 只有會議紀錄回非 JSON；badform → 只有表單（擴充包，例如 IEP 會議紀錄）回非 JSON；badagenda → 只有議程回非 JSON；badcheck → 只有會議中的議程判斷回非 JSON；badnames → 只有 AI 修正（原更正名字）回非 JSON；badmodule → 只有延伸模組回空白；badonce → 只有第一則回非 JSON；die → 讀到第一則就結束；error → result 帶 is_error；limit → 額度用完（is_error＋429）；auth → 登入過期；hang → 讀了不回。
收到「整理程序剛重新啟動」的補前文時，摘要前面加「接續：」，測試用來確認有補。
FAKE_PROMPT_LOG 有設時，每則收到的提示記一行 JSON 字串到那個檔。
FAKE_DELAY_FILE 指到的檔案存在時，每則回覆前先等檔案裡寫的秒數（e2e 用來模擬整理很慢，#126）；每則都重讀，測試中途可以改。
"""
import json
import os
import sys
import time

mode = os.environ.get("FAKE_MODE", "")
n = 0
for line in sys.stdin:
    msg = json.loads(line)
    prompt = msg["message"]["content"]
    n += 1
    if os.environ.get("FAKE_PROMPT_LOG"):   # 測試看送了什麼提示
        with open(os.environ["FAKE_PROMPT_LOG"], "a", encoding="utf-8") as fh:
            fh.write(json.dumps(prompt, ensure_ascii=False) + "\n")
    if mode == "die":
        sys.exit(1)
    if mode == "hang":
        continue
    try:
        time.sleep(float(open(os.environ["FAKE_DELAY_FILE"], encoding="utf-8").read()))
    except (KeyError, OSError, ValueError):
        pass
    print(json.dumps({"type": "system", "subtype": "init"}), flush=True)
    if mode == "error":
        print(json.dumps({"type": "result", "is_error": True, "result": ""}), flush=True)
        continue
    if mode == "limit":
        print(json.dumps({"type": "result", "is_error": True, "api_error_status": 429, "result": "Claude AI usage limit reached|1760000000"}), flush=True)
        continue
    if mode == "auth":
        print(json.dumps({"type": "result", "is_error": True, "result": "Invalid API key · Please run /login"}), flush=True)
        continue
    if "要請你修正內容" in prompt:
        # 更正名字（#130）：把使用者說明帶回第一組讓測試確認有放進 prompt；故意給：內容裡沒有的、一個字的、正字包含錯字的、
        # 重複的錯字、非字串、壞格式，測試驗證
        request = prompt.split("<request>\n", 1)[1].split("\n</request>", 1)[0]
        reply = "更正不是 JSON" if mode == "badnames" else json.dumps({"pairs": [
            {"wrong": "書上", "right": request[-2:]}, {"wrong": "報告", "right": "報吿"}, {"wrong": "不存在的字", "right": "x"}, {"wrong": "書", "right": "學"},
            {"wrong": "學障", "right": "學障生"}, {"wrong": "書上", "right": "別的"}, ["下周", "下週"], {"wrong": 1, "right": "x"}, "壞的",
        ]}, ensure_ascii=False)
    elif "<module>" in prompt:
        # 延伸模組（#136）：把指示的第一行與 <role> 帶回來，測試確認選項有換進去；故意包 ``` 和一級標題、留「下周」測試固定替換
        inst = prompt.split("<module>\n", 1)[1].split("\n</module>", 1)[0]
        role = inst.split("<role>\n", 1)[1].split("\n</role>", 1)[0] if "<role>" in inst else ""
        reply = "" if mode == "badmodule" else f"```markdown\n# 模組結果\n## {inst.splitlines()[0][:12]}\n- 視角：{role[:6]}\n- 書上學生下周再談\n```"
    elif "整理成一張心智圖" in prompt:
        # 故意給：空議題、太多重點、帶句號、第四層、非字串，測試整理與上限
        reply = json.dumps({
            "center": "IEP 會議。",
            "branches": [
                {"label": "閱讀進度", "children": [{"label": "書上學生進步"}, {"label": "朗讀流暢度", "children": [{"label": "每週測一次", "children": [{"label": "第四層要丟掉"}]}]}]},
                {"label": "", "children": [{"label": "沒標題要丟掉"}]},
                {"label": "評量調整", "children": [{"label": f"重點{i}"} for i in range(8)]},
                {"label": "待辦", "children": [{"label": "導師下周三前給清單。"}, {"label": True}]},
            ],
        }, ensure_ascii=False)
    elif "還沒確認談過的項目" in prompt:
        # 會議中的議程判斷（#97）：第一個還沒談的項目算談到（段落編號給 1），再給不存在的 id、重複、壞段落
        ids = [line[2:].split("：", 1)[0] for line in prompt.splitlines() if line.startswith("- ")]
        reply = "議程判斷不是 JSON" if mode == "badcheck" else json.dumps({"covered": (
            [{"id": ids[0], "para": 1, "note": f"談到{ids[0]}\u0007"}, {"id": ids[0], "para": 2}, {"id": "nope", "para": 1},
             {"id": [ids[0]], "para": 1}, "壞的"]
            + ([{"id": ids[1], "para": 999, "note": "段落不存在"}] if len(ids) > 1 else []))}, ensure_ascii=False)
    elif "議程項目（id：說明）" in prompt:
        # 開會前的議程（#97）：年級從學生資料來；提問引用學生資料；學生資料裡有鑑輔到期就多一項；故意給不存在的 id 與格式錯誤
        student = prompt.split("學生資料：", 1)[1]
        reply = "議程不是 JSON" if mode == "badagenda" else json.dumps({
            "facts": {"grade": 6 if "六甲" in student else 3, "class": "甲"},
            "items": {"student": "請小安用圖卡說說最喜歡的課", "transition": "六年級要談升國中的轉銜", "nope": "不存在的項目",
                      "parent": True, "behavior": "上次決議：數學抽離 4 節" if "上次決議" in student else "沒讀到上次紀錄"},
            "extra": [{"title": "鑑輔到期" if "鑑輔有效至" in student else "沒有鑑輔資料", "detail": "要不要申請重新鑑定"},
                      {"title": ""}, "壞的"],
        }, ensure_ascii=False)
    elif "表上的欄位（id：說明）" in prompt:
        # 故意給：不認得的欄位、範本上沒有的選項、不合法的二選一、控制字元、沒設 on 但有填內容；把會議別帶回來讓測試確認有放進 prompt
        title = prompt.split("這是一場「", 1)[1].split("」", 1)[0]
        reply = "紀錄不是 JSON" if mode == "badform" else json.dumps({
            "header": {"name": "王小明", "chair": "校長", "hacker": "不該出現"},
            "items": {
                "student": {"text": f"{title}：個案表示喜歡閱讀\u0007。\n希望數學進步。"},
                "parent": {"text": "家長表示在家作息穩定。"},
                "ability": {"text": "閱讀理解進步"},
                "chinese": {"on": True, "mode": "外加", "blanks": {"periods": "3", "nope": "x"}},
                "math": {"on": True, "mode": "亂寫"},
                "exam_time": {"on": True, "options": {"延長考試時間20分鐘": True, "不存在的選項": True}},
                "exam_paper": {"options": {"其他": "題目加注音"}},
                "pro": {"on": True, "options": {"巡迴輔導": "情緒行為", "職能治療": True}},
                "trans_none": {"on": True},
                "not_a_field": {"on": True},
            },
        }, ensure_ascii=False)
    elif "會議紀錄模板" in prompt:
        # 待辦故意亂序、期限有壞格式、狀態有怪值、有空事項，測試整理與排序；摘要帶回模板標題和日期讓測試確認有放進 prompt
        title = prompt.split("<template>\n", 1)[1].splitlines()[0]
        date = prompt.split("會議的日期是 ", 1)[1].split("（", 1)[0]
        reply = "紀錄不是 JSON" if mode == "badminutes" else json.dumps({
            "summary": f"{title}｜{date}｜下周再談",
            "actions": [
                {"item": "沒期限的事", "owner": "導師", "due": "", "status": "未開始"},
                {"item": "晚一點的事", "owner": "我", "due": "2026-11-03", "due_text": "下週二", "status": "進行中"},
                {"item": "壞日期", "owner": "", "due": "下週三", "status": "不知道"},
                {"item": "", "owner": "空事項要丟掉"},
                {"item": True, "owner": "布林事項要丟掉"},
                {"item": "早一點的事", "owner": "媽媽", "due": "2026-10-23", "status": "已完成"},
            ],
            "decisions": ["每週兩節", "", False],
            "questions": ["要問 OT 時段"],
            "sections": [{"title": "學生現況", "points": ["閱讀進步"]}, {"title": "", "points": ["沒標題要丟掉"]}],
        }, ensure_ascii=False)
    elif "會後總結包" in prompt:
        # 章節時間故意給：不在段落開始、同段重複、超出範圍、看不懂，測試對齊
        recap = "接續：" if "整理程序剛重新啟動" in prompt else ""
        resum = "重產：" if "<transcript>" in prompt else ""
        reply = "總結不是 JSON" if mode == "badsummary" else json.dumps({
            "intro": f"{recap}{resum}這場在談書上學生的評估",
            "chapters": [{"t": "00:00:06", "title": "第二部分"}, {"t": "00:00:03", "title": "開場"},
                         {"t": "00:00:07", "title": "重複"}, {"t": "99:00:00", "title": "最後"}, {"t": "亂寫", "title": "壞"}],
            "full": "## 核心結論\n下周再談\n## 章節重點\n### 開場\n- 重點",
            "short": "下周再評估。",
        }, ensure_ascii=False)
    elif "<transcript>" in prompt:
        text = prompt.split("<transcript>\n", 1)[1].split("\n</transcript>", 1)[0]
        recap = "接續：" if "整理程序剛重新啟動" in prompt else ""
        bad = mode == "bad" or (mode == "badonce" and n == 1)
        obj = {"corrected": text.replace("書上", "學障"), "summary": f"{recap}第{n}則重點，下周再談"}
        if text.startswith("接著"):
            obj["new_topic"] = False   # 沒寫就是新話題
        if '"readable"' in prompt:
            # 逐字稿優化：刪口頭禪；故意留「下周」測試固定替換也套到好讀版
            obj["readable"] = text.replace("書上", "學障").replace("嗯", "").replace("就是", "")
        reply = "這不是 JSON" if bad else "```json\n" + json.dumps(obj, ensure_ascii=False) + "\n```"
    else:
        reply = f"## 大綱\n- 已處理 {n} 則訊息"
    # 用量：tokens 每次固定，total_cost_usd 照真的 Claude Code 是這個程序內的累計值
    usage = {"input_tokens": 10, "output_tokens": 5, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 50}
    print(json.dumps({"type": "result", "is_error": False, "result": reply, "usage": usage, "total_cost_usd": round(0.01 * n, 4)}, ensure_ascii=False), flush=True)
