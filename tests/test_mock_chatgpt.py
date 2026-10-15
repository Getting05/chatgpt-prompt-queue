from playwright.sync_api import sync_playwright
from pathlib import Path
import os

SCRIPT=str(Path(__file__).resolve().parents[1] / 'content.js')
HTML='''<!doctype html><html><head></head><body>
<form id="chat-form"><div id="prompt-textarea" contenteditable="true" role="textbox"></div><button type="button" data-testid="send-button">Send</button><button type="button" data-testid="stop-button">Stop</button></form>
<script>
window.sent=[];
window.finish=()=>document.querySelector('[data-testid="stop-button"]')?.remove();
document.querySelector('[data-testid="send-button"]').addEventListener('click',()=>{
 const e=document.querySelector('#prompt-textarea');
 window.sent.push(e.innerText);
 e.innerHTML='';
 if(!document.querySelector('[data-testid="stop-button"]')) {
  const b=document.createElement('button'); b.setAttribute('data-testid','stop-button');b.textContent='Stop';document.querySelector('form').append(b);
 }
});
</script>
</body></html>'''

def test_enqueue_and_sequential_send():
    with sync_playwright() as p:
        chromium = os.getenv('CHROMIUM_EXECUTABLE') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
        browser=p.chromium.launch(executable_path=chromium, headless=True, args=['--no-sandbox'])
        page=browser.new_page()
        errors=[]
        page.on('pageerror', lambda exc: errors.append(str(exc)))
        page.set_content(HTML)
        page.add_script_tag(path=SCRIPT)
        page.wait_for_timeout(100)
        assert page.locator('#cgpt-queue-extension-host').count()==1
        inp=page.locator('#prompt-textarea')
        inp.click()
        inp.fill('问题 B')
        inp.press('Enter')
        page.wait_for_timeout(250)
        n=page.evaluate("document.querySelector('#cgpt-queue-extension-host').shadowRoot.getElementById('count').textContent")
        print('after Enter:',n,'composer:',repr(inp.inner_text()))
        assert '1' in n and not inp.inner_text().strip(), 'Native Enter queue failed'

        panel=page.locator('#cgpt-queue-extension-host')
        panel.locator('#pill').click()
        panel.locator('#draft').fill('问题 C')
        panel.locator('#add').click()
        assert '2' in panel.locator('#count').inner_text()
        assert page.evaluate('window.sent')==[]
        page.evaluate('window.finish()')
        page.wait_for_timeout(2900)
        print('after first finished:',page.evaluate('window.sent'))
        assert page.evaluate('window.sent')==['问题 B']
        page.wait_for_timeout(2200)
        assert page.evaluate('window.sent')==['问题 B'], 'Sent twice during generation'
        page.evaluate('window.finish()')
        page.wait_for_timeout(2900)
        print('after second finished:',page.evaluate('window.sent'))
        assert page.evaluate('window.sent')==['问题 B','问题 C']
        assert '0' in panel.locator('#count').inner_text()
        assert not errors,errors
        browser.close()
        print('PASS: native Enter, busy detection, sequential delivery, no duplicate clicks')


def test_manual_pause_prevents_auto_send_until_resumed():
    with sync_playwright() as p:
        chromium = os.getenv('CHROMIUM_EXECUTABLE') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
        browser = p.chromium.launch(executable_path=chromium, headless=True, args=['--no-sandbox'])
        page = browser.new_page()
        page.set_content(HTML)
        page.add_script_tag(path=SCRIPT)
        editor = page.locator('#prompt-textarea')
        editor.fill('等待恢复的问题')
        editor.press('Enter')
        panel = page.locator('#cgpt-queue-extension-host')
        panel.locator('#pill').click()
        assert '1' in panel.locator('#count').inner_text()
        panel.locator('#toggle').click()
        page.evaluate('window.finish()')
        page.wait_for_timeout(2000)
        assert page.evaluate('window.sent') == [], 'Paused extension sent a prompt'
        panel.locator('#toggle').click()
        page.wait_for_timeout(1850)
        assert page.evaluate('window.sent') == ['等待恢复的问题']
        browser.close()
