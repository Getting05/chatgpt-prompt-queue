"""UI defaults and in-page theme changes, tested against a mock ChatGPT DOM."""
from playwright.sync_api import sync_playwright

from test_dynamic_send import SCRIPT, launch_browser, mock_page


def panel_state(page):
    return page.evaluate("""() => {
        const h = document.querySelector('#cgpt-queue-extension-host');
        return {
            theme: h.dataset.theme,
            pillVisible: h.shadowRoot.getElementById('pill').style.display !== 'none',
            panelVisible: h.shadowRoot.getElementById('panel').style.display !== 'none',
            color: getComputedStyle(h.shadowRoot.getElementById('panel')).backgroundColor,
        };
    }""")


def test_collapsed_by_default_even_with_previous_expanded_preference():
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page()
        mock_html = mock_page('<div id="prompt-textarea" contenteditable="true"></div>')
        page.route('https://queue.test/**', lambda route: route.fulfill(
            status=200, content_type='text/html', body=mock_html
        ))
        page.goto('https://queue.test/chat')
        page.evaluate("""sessionStorage.setItem('__cgpt_next_question_queue_v1',
            JSON.stringify({expanded:true, nativeEnter:true, queues:{}}))""")
        page.add_script_tag(path=SCRIPT)
        host = page.locator('#cgpt-queue-extension-host')
        state = panel_state(page)
        assert state['pillVisible']
        assert not state['panelVisible']
        host.locator('#pill').click()
        assert host.locator('#panel').is_visible()
        host.locator('#collapse').click()
        assert not host.locator('#panel').is_visible()
        # Reloading with old expanded=true data also starts collapsed.
        page.reload()
        page.add_script_tag(path=SCRIPT)
        assert panel_state(page)['pillVisible']
        assert not panel_state(page)['panelVisible']
        browser.close()


def test_site_theme_overrides_system_and_changes_live():
    with sync_playwright() as p:
        browser = launch_browser(p)
        context = browser.new_context(color_scheme='dark')  # OS dark; webpage light.
        page = context.new_page()
        page.set_content(mock_page('<div id="prompt-textarea" contenteditable="true"></div>'))
        page.evaluate("document.documentElement.classList.add('light')")
        page.add_script_tag(path=SCRIPT)
        light = panel_state(page)
        assert light['theme'] == 'light'
        page.evaluate("""() => {
            document.documentElement.classList.remove('light');
            document.documentElement.classList.add('dark');
        }""")
        page.wait_for_function(
            "document.querySelector('#cgpt-queue-extension-host').dataset.theme === 'dark'"
        )
        dark = panel_state(page)
        assert dark['color'] != light['color']
        page.evaluate("""() => {
            document.documentElement.classList.remove('dark');
            document.documentElement.setAttribute('data-theme', 'light');
        }""")
        page.wait_for_function(
            "document.querySelector('#cgpt-queue-extension-host').dataset.theme === 'light'"
        )
        assert panel_state(page)['color'] == light['color']
        context.close()
        browser.close()


def test_compact_labels_and_queue_count_when_collapsed():
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page()
        page.set_content(mock_page('<div id="prompt-textarea" contenteditable="true"></div>'))
        page.add_script_tag(path=SCRIPT)
        host = page.locator('#cgpt-queue-extension-host')
        assert host.locator('#pill').is_visible()
        assert '队列 0' in host.locator('#pill').inner_text()
        host.locator('#pill').click()
        host.locator('#draft').fill('Question queued')
        host.locator('#add').click()
        host.locator('#collapse').click()
        assert '队列 1' in host.locator('#pill').inner_text()
        browser.close()
