const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const logger = require("../utils/logger");

class WhatsAppClient {
  constructor(options = {}) {
    const defaultSessionPath = process.env.WHATSAPP_SESSION_PATH || "./.wweb-session";
    this.sessionPath = path.resolve(defaultSessionPath);
    this.headless = options.headless ?? false;
    this.browser = null;
    this.page = null;
  }

  async launch() {
    fs.mkdirSync(this.sessionPath, { recursive: true });

    this.browser = await puppeteer.launch({
      headless: this.headless,
      userDataDir: this.sessionPath,
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    this.page = await this.browser.newPage();
    await this.page.goto("https://web.whatsapp.com", { waitUntil: "networkidle2" });

    const isLoggedIn = await this.waitForLogin(60000);
    if (!isLoggedIn) {
      logger.info("Scan the QR code in the opened browser window for WhatsApp login.");
      await this.waitForLogin(180000);
    }

    logger.info("WhatsApp session is ready.");
  }

  async waitForLogin(timeoutMs) {
    try {
      await this.page.waitForSelector('div[contenteditable="true"][data-tab], div[role="textbox"]', {
        timeout: timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  async sendMessage(phone, message) {
    if (!this.page) {
      throw new Error("WhatsApp client is not initialized.");
    }

    const cleanedPhone = String(phone).replace(/[^\d]/g, "");
    if (!cleanedPhone) {
      throw new Error("Invalid phone number.");
    }

    const targetUrl = `https://web.whatsapp.com/send?phone=${encodeURIComponent(
      cleanedPhone
    )}&text=${encodeURIComponent(message)}`;

    await this.page.goto(targetUrl, { waitUntil: "networkidle2" });

    await this.page.waitForSelector('div[contenteditable="true"][data-tab], div[role="textbox"]', {
      timeout: 30000,
    });

    const sendButtonSelector = 'button span[data-icon="send"]';

    try {
      await this.page.waitForSelector(sendButtonSelector, { timeout: 10000 });
      await this.page.click(sendButtonSelector);
    } catch {
      await this.page.keyboard.press("Enter");
    }

    await this.page.waitForTimeout(1500);
    logger.info("WhatsApp message sent.", { phone: cleanedPhone });
    return { ok: true, phone: cleanedPhone };
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

module.exports = {
  WhatsAppClient,
};
