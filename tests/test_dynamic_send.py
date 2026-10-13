"""Regression cases for ChatGPT layouts in which Send is created after text input.

These are simulated DOM tests, not an authenticated ChatGPT end-to-end test.
"""
from pathlib import Path
import os

from playwright.sync_api import sync_playwright

SCRIPT = str(Path(__file__).resolve().parents[1] / 'content.js')


def launch_browser(p):
    chromium = os.getenv('CHROMIUM_EXECUTABLE') or (
        '/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None
    )
    return p.chromium.launch(executable_path=chromium, headless=True, args=['--no-sandbox'])


def mock_page(editor, *, hidden_stop=False, never_show_send=False):
    return f'''<!doctype html><html><body>
    <form data-chatgpt-composer>{editor}
        <button type="button" data-testid="stop-button" id="stop">Stop</button>
    </form>
    <script>
        window.sent = [];
        const form = document.querySelector('form');
        const editor = form.querySelector('[contenteditable="true"]');
        window.finish = () => {{
            const stop = document.getElementById('stop');
            if (stop) {{ {'stop.style.display = "none";' if hidden_stop else 'stop.remove();'} }}
        }};
        const neverShow = {str(never_show_send).lower()};
        function updateButton() {{
            let btn = form.querySelector('[data-testid="send-button"]');
            if (!editor.innerText.trim() || neverShow) {{ btn?.remove(); return; }}
            if (!btn) {{
                btn = document.createElement('button');
                btn.type = 'button';
                btn.dataset.testid = 'send-button';
                btn.id = 'composer-submit-button';
                btn.setAttribute('aria-label','Send prompt');
                btn.setAttribute('aria-disabled','true');
                form.appendChild(btn);
                setTimeout(() => btn.setAttribute('aria-disabled','false'), 100);
                btn.addEventListener('click', () => {{
                    if (btn.getAttribute('aria-disabled') === 'true') return;
                    window.sent.push(editor.innerText.trim());
                    editor.textContent = '';
                    btn.remove();
                    let stop = document.getElementById('stop');
                    if (stop) stop.style.display = '';
                    else {{
                        stop = document.createElement('button');
                        stop.type = 'button';
                        stop.id = 'stop';
                        stop.dataset.testid = 'stop-button';
                        stop.textContent = 'Stop';
                        form.appendChild(stop);
                    }}
                }});
            }}
        }}
        editor.addEventListener('input', updateButton);
    </script>
    </body></html>'''


def install(page, html):
    page.set_content(html)
    page.add_script_tag(path=SCRIPT)
    host = page.locator('#cgpt-queue-extension-host')
    assert host.count() == 1
    return host


def test_send_button_absent_until_text_inserted():
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page()
        host = install(page, mock_page('<div class="ProseMirror" contenteditable="true" role="textbox"></div>'))
        assert page.locator('[data-testid="send-button"]').count() == 0
        host.locator('#draft').fill('问题：动态发送按钮')
        host.locator('#add').click()
        page.evaluate('window.finish()')
        page.wait_for_function("window.sent.length === 1", timeout=7000)
        assert page.evaluate('window.sent') == ['问题：动态发送按钮']
        page.wait_for_function("document.querySelector('#cgpt-queue-extension-host').shadowRoot.getElementById('count').textContent.includes('(0)')", timeout=2500)
        browser.close()


def test_lexical_editor_and_hidden_stale_stop_button():
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page()
        host = install(page, mock_page('''<div data-testid="prompt-textarea">
            <div contenteditable="true" data-lexical-editor="true" role="textbox"></div>
        </div>''', hidden_stop=True))
        host.locator('#draft').fill('Lexical queued')
        host.locator('#add').click()
        page.evaluate('window.finish()')
        page.wait_for_function('window.sent.length === 1', timeout=7000)
        assert page.evaluate('window.sent') == ['Lexical queued']
        browser.close()


def test_no_send_button_does_not_lose_prompt_or_retry():
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page()
        host = install(page, mock_page('<div id="prompt-textarea" contenteditable="true"></div>', never_show_send=True))
        host.locator('#draft').fill('Keep this queued')
        host.locator('#add').click()
        page.evaluate('window.finish()')
        page.wait_for_function("document.querySelector('#cgpt-queue-extension-host').shadowRoot.getElementById('toggle').textContent.includes('继续')", timeout=11000)
        assert page.evaluate('window.sent') == []
        assert '1' in host.locator('#count').inner_text()
        assert '发送按钮' in host.locator('#status').inner_text()
        browser.close()
