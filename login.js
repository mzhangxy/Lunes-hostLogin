const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');

puppeteer.use(StealthPlugin());

async function sendTelegramMessage(botToken, chatId, message) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown'  // 可选：支持格式化
  }).catch(error => {
    console.error('Telegram 通知失败:', error.message);
  });
}

async function solveTurnstile(page, sitekey, pageUrl) {
  const apiKey = process.env.CAPTCHA_API_KEY;
  if (!apiKey) throw new Error('CAPTCHA_API_KEY 未设置');

  // 注入脚本以捕获额外参数（针对Challenge pages）
  await page.evaluateOnNewDocument(() => {
    const i = setInterval(() => {
      if (window.turnstile) {
        clearInterval(i);
        const originalRender = window.turnstile.render;
        window.turnstile.render = (widget, options) => {
          window.tsParams = {
            sitekey: options.sitekey,
            action: options.action,
            cData: options.cData,
            chlPageData: options.chlPageData,
            callback: options.callback
          };
          // 不实际渲染widget，防止自动执行
          return 'mock-widget-id';
        };
      }
    }, 50);
  });

  // 重新加载页面以应用注入
  await page.reload({ waitUntil: 'networkidle2' });

  // 提取额外参数，如果存在
  const tsParams = await page.evaluate(() => window.tsParams || {});
  const params = {
    key: apiKey,
    method: 'turnstile',
    sitekey: sitekey || tsParams.sitekey,
    pageurl: pageUrl,
    json: 1
  };
  if (tsParams.action) params.action = tsParams.action;
  if (tsParams.cData) params.data = tsParams.cData;
  if (tsParams.chlPageData) params.pagedata = tsParams.chlPageData;

  const submitTaskRes = await axios.post('https://2captcha.com/in.php', params);

  if (submitTaskRes.data.status !== 1) {
    throw new Error(`提交任务失败: ${submitTaskRes.data.request}`);
  }

  const taskId = submitTaskRes.data.request;

  let result;
  for (let i = 0; i < 30; i++) {  // 增加到30次，约2.5分钟
    await page.waitForTimeout(5000);
    const getResultRes = await axios.get(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
    if (getResultRes.data.status === 1) {
      result = getResultRes.data.request;
      break;
    }
    if (getResultRes.data.request === 'CAPCHA_NOT_READY') {
      continue;
    }
    throw new Error(`获取结果失败: ${getResultRes.data.request}`);
  }

  if (!result) throw new Error('Turnstile 解决超时');

  // 如果有useragent（针对Challenge），设置User-Agent
  if (result.useragent) {
    await page.setUserAgent(result.useragent);
    await page.reload({ waitUntil: 'networkidle2' });
  }

  // 注入token
  await page.evaluate((token, callbackName) => {
    const input = document.querySelector('input[name="cf-turnstile-response"]');
    if (input) {
      input.value = token;
    } else if (callbackName && window[callbackName]) {
      window[callbackName](token);
    } else if (window.tsParams && window.tsParams.callback) {
      window.tsParams.callback(token);
    }
  }, result.token || result, tsParams.callback);

  console.log('Turnstile 已解决');
}

async function login() {
  // 检查所有必需环境变量
  const requiredEnvs = ['WEBSITE_URL', 'USERNAME', 'PASSWORD', 'CAPTCHA_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  for (const env of requiredEnvs) {
    if (!process.env[env]) throw new Error(`${env} 未设置`);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  const page = await browser.newPage();

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    await page.goto(process.env.WEBSITE_URL, { waitUntil: 'networkidle2' });

    await page.type('#email', process.env.USERNAME);
    await page.type('#password', process.env.PASSWORD);

    // 等待Turnstile元素
    await page.waitForSelector('.cf-turnstile', { timeout: 15000 });

    const sitekey = await page.evaluate(() => {
      const el = document.querySelector('.cf-turnstile');
      return el ? el.getAttribute('data-sitekey') : null;
    });
    if (!sitekey) throw new Error('未找到 sitekey');
    const currentUrl = page.url();

    await solveTurnstile(page, sitekey, currentUrl);

    await page.click('button[type="submit"]');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });

    const currentUrlAfter = page.url();
    const title = await page.title();

    // 改进成功判断：检查是否重定向到非登录页，或检查特定元素
    const isSuccess = !currentUrlAfter.includes('login') && !title.toLowerCase().includes('login');
    if (isSuccess) {
      await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, `*登录成功！*\n时间: ${new Date().toISOString()}\n页面: ${currentUrlAfter}\n标题: ${title}`);
      console.log('登录成功！当前页面：', currentUrlAfter);
    } else {
      throw new Error(`登录可能失败。当前 URL: ${currentUrlAfter}, 标题: ${title}`);
    }

    console.log('脚本执行完成。');
  } catch (error) {
    const screenshotPath = `login-failure-${Date.now()}.png`;  // 动态文件名避免覆盖
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, `*登录失败！*\n时间: ${new Date().toISOString()}\n错误: ${error.message}\n请检查 Artifacts 中的 ${screenshotPath}`);
    console.error('登录失败：', error.message);
    console.error(`截屏已保存为 ${screenshotPath}`);
    throw error;
  } finally {
    await browser.close();
  }
}

login();
