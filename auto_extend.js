const {chromium} = require('playwright');
const fs = require('fs');

// Load config: check if a local config file exists, otherwise use defaults
let config = { triggerThresholdHours: 6 }; 
if (fs.existsSync('config.json')) {
    config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
}

async function run() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: 'D:\\github\\G4f\\storageState.json' });
    const page = await context.newPage();
    
    await page.goto('https://control.gaming4free.net/server/48709f0f/console', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Optimizat pentru Render: fara asteptare de elemente vizibile, direct textul
    const result = await page.evaluate(async (threshold) => {
        const bodyText = document.body.innerText;
        const timeMatch = bodyText.match(/(\d+):(\d+):(\d+)remaining/);
        
        if (!timeMatch) return { error: 'Time not found' };
        
        const hours = parseInt(timeMatch[1]);
        if (hours > threshold) return { skipped: true, hours };

        // Cautare robusta buton
        const buttons = Array.from(document.querySelectorAll('button, a'));
        const target = buttons.find(b => b.innerText.includes('get 3 hours'));
        if (target) {
            target.click();
            return { success: true, hours };
        }
        return { error: 'Button not found' };
    }, config.triggerThresholdHours);

    console.log("Result:", result);
    await browser.close();
}

run().catch(console.error);
