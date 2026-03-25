test_GUI已创建完毕，结构与 jiuge_GUI 一致：


test_GUI/
├── package.json
├── main.js
├── preload.js
├── index.html
├── style.css
├── renderer.js
└── start.bat
10个脚本按类别分组显示在左侧边栏：

分组	脚本
数学推理	test_GSM8k.js
DROP阅读理解	test_DROP.js / test_DROP300.js / test_DROP300_NUM.js / validate_drop_fixed.js
MMLU 综合	test_MMLU.js / test_MMLU_invaild.js
知识问答	test_TriviaQA.js
九格测试 (OpenAI API)	test_jiuge_local.js / test_jiuge_final.js
与 jiuge_GUI 的区别：

主题色改为橙色（amber），方便区分两个 GUI
信息栏同时显示两个 API 端点（127.0.0.1:1145 和 localhost:8000）
脚本工作目录指向 ../jiuge_nvda 
