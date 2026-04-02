// test_single.js
// 测试运行配置
const CONFIG = {
    url: "http://172.22.162.17:8000/chat/completions",
    model: "9g_8b_thinking",
 prompt: " "
};

async function testConnection() {
 console.log("1. 172.22.162.17:8000 ...");
    
    try {
// 处理testConnection相关逻辑
        const healthCheck = await fetch("http://172.22.162.17:8000/", { method: "GET" });
 console.log(`2. : [HTTP ${healthCheck.status}] ( 404/405/200 )`);
    } catch (e) {
 console.error(" : 172.22.162.17:8000 VS Code ");
 console.error(" :", e.message);
        return; // 输出错误信息
    }

 console.log("3. ( )...");
    const t0 = Date.now();

    try {
        const response = await fetch(CONFIG.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: CONFIG.model,
                messages: [{ role: "user", content: CONFIG.prompt }],
// 处理testConnection相关逻辑
                stream: false, 
                max_tokens: 1024,
                temperature: 0.8
            })
        });

        if (!response.ok) {
 throw new Error(` : ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const t1 = Date.now();
        const answer = data.choices[0].message.content;

 console.log("\n === SUCCESS ===\n");
 console.log(` : ${((t1 - t0)/1000).toFixed(2)} `);
 console.log(" :");
        console.log("-----------------------------");
        console.log(answer);
        console.log("-----------------------------");

    } catch (error) {
 console.error("\n :");
        console.error(error.message);
    }
}

testConnection();
