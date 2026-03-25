// ── DOM refs ──
const outputEl     = document.getElementById('output');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const stopBtn      = document.getElementById('stop-btn');
const clearBtn     = document.getElementById('clear-btn');
const resultsBtn   = document.getElementById('results-btn');
const statProgress = document.getElementById('stat-progress');
const statAcc      = document.getElementById('stat-acc');
const statTime     = document.getElementById('stat-time');
const valProgress  = document.getElementById('val-progress');
const valAcc       = document.getElementById('val-acc');
const valTime      = document.getElementById('val-time');

let lines = [];
let curLine = '';
let activeBtn = null;

function stripAnsi(s) {
  return s.replace(/\x1B\[[0-9;]*[mGKHJFABCDsu]/g, '');
}

function lineClass(text) {
  if (/^={3,}/.test(text))                         return 'sep';
  if (/✓|correct|ok.*true/i.test(text))            return 'ok';
  if (/✗|wrong|error|fail|启动失败/i.test(text))    return 'fail';
  if (/stderr|exception/i.test(text))              return 'err';
  return '';
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderOutput() {
  const all = [...lines, curLine];
  outputEl.innerHTML = all.map(l => {
    const cls = lineClass(l);
    return `<div class="line${cls ? ' ' + cls : ''}">${escHtml(l)}</div>`;
  }).join('');
  outputEl.parentElement.scrollTop = outputEl.parentElement.scrollHeight;
}

function processChunk(text) {
  text = stripAnsi(text);
  for (const ch of text) {
    if (ch === '\r') {
      curLine = '';
    } else if (ch === '\n') {
      lines.push(curLine);
      parseStats(curLine);
      curLine = '';
    } else {
      curLine += ch;
    }
  }
  renderOutput();
}

function parseStats(line) {
  const progMatch = line.match(/\[(\d+)\/(\d+)\]/) || line.match(/(\d+)\/(\d+)\s*题/);
  if (progMatch) {
    statProgress.style.display = '';
    valProgress.textContent = `${progMatch[1]} / ${progMatch[2]}`;
  }

  const accMatch = line.match(/[Aa]ccuracy[:\s]+(\d+\.?\d*%)/i) ||
                   line.match(/准确率[:\s：]+(\d+\.?\d*%)/);
  if (accMatch) {
    statAcc.style.display = '';
    valAcc.textContent = accMatch[1];
  }

  const timeMatch = line.match(/[Aa]vg[^:]*:\s*([\d.]+)\s*ms/i) ||
                    line.match(/平均[^:：]*[：:]\s*([\d.]+)\s*ms/);
  if (timeMatch) {
    statTime.style.display = '';
    valTime.textContent = `${timeMatch[1]} ms`;
  }
}

function setRunning(name) {
  statusDot.className = 'dot running';
  statusText.textContent = `运行中: ${name}`;
  stopBtn.disabled = false;
  document.querySelectorAll('.test-btn').forEach(b => b.disabled = true);
  statProgress.style.display = 'none';
  statAcc.style.display = 'none';
  statTime.style.display = 'none';
}

function setDone(code) {
  statusDot.className = code === 0 ? 'dot done' : 'dot error';
  statusText.textContent = code === 0 ? '完成' : `异常退出 (${code})`;
  stopBtn.disabled = true;
  document.querySelectorAll('.test-btn').forEach(b => {
    b.disabled = false;
    b.classList.remove('active');
  });
  activeBtn = null;
}

// ── 按钮事件 ──
document.querySelectorAll('.test-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const script = btn.dataset.script;
    const name   = btn.dataset.name;

    lines = []; curLine = '';
    outputEl.innerHTML = '';

    if (activeBtn) activeBtn.classList.remove('active');
    activeBtn = btn;
    btn.classList.add('active');

    setRunning(name);
    processChunk(`=== 启动: ${name} ===\n`);

    await window.api.runTest(script);
  });
});

stopBtn.addEventListener('click', async () => {
  await window.api.stopTest();
  processChunk('\n=== 已手动停止 ===\n');
  statusDot.className = 'dot idle';
  statusText.textContent = '已停止';
  stopBtn.disabled = true;
  document.querySelectorAll('.test-btn').forEach(b => {
    b.disabled = false;
    b.classList.remove('active');
  });
  activeBtn = null;
});

clearBtn.addEventListener('click', () => {
  lines = []; curLine = '';
  outputEl.innerHTML = '';
});

resultsBtn.addEventListener('click', () => window.api.openResults());

// ── IPC 回调 ──
window.api.onOutput((data) => processChunk(data));
window.api.onOutputErr((data) => processChunk(data));
window.api.onTestDone((code) => {
  if (curLine) { lines.push(curLine); curLine = ''; }
  processChunk(`\n=== 测试结束 (退出码: ${code}) ===\n`);
  setDone(code);
});
