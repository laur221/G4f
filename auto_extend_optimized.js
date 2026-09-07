const {chromium} = require('playwright');

async function run() {
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--single-process',
            '--no-zygote',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
    
    // Use the existing session
    const context = await browser.newContext({ storageState: 'D:\\github\\G4f\\storageState.json' });
    const page = await context.newPage();
    
    console.log("Navigating...");
    await page.goto('https://control.gaming4free.net/server/48709f0f/console', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Click the extension button
    const result = await page.evaluate(async () => {
        const buttons = Array.from(document.querySelectorAll('button, a'));
        const target = buttons.find(b => b.innerText.includes('get 3 hours'));
        if (target) {
            target.click();
            return { success: true };
        }
        return { error: 'Button not found' };
    });

    console.log("Result:", result);
    await browser.close();
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
