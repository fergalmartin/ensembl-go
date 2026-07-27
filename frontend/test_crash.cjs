const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();

    page.on('pageerror', exception => {
        console.log(`Uncaught exception: "${exception}"`);
    });

    page.on('console', msg => {
        if (msg.type() === 'error')
            console.log(`Console error: "${msg.text()}"`);
    });

    await page.goto('http://localhost:5174/');
    // Click the Genome Browser to trigger crash
    await page.waitForTimeout(1000);
    try {
        await page.click('text="Genome Browser"');
        await page.waitForTimeout(2000); // give it time to crash
    } catch (e) {
        console.log("Could not find Genome Browser click target.");
    }
    await browser.close();
})();
