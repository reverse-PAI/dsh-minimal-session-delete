/**
 * Browser half of `@local/dsh-session-delete`.
 *
 * Two entry points next to the shipped archive action, reproducing its art
 * one-for-one: the menu row is `MenuItemButton`'s exact DOM/CSS plus the host's
 * 16-viewBox / 1px-stroke outline icon and shortcut chip; the hover button is
 * the row strip's `iconButton` geometry plus the host tooltip look; the dialog
 * is `Modal`'s exact structure and CSS with two `outline` buttons, the confirm
 * one taking the archive dialog's error text color.
 *
 * No Harness Client package is imported as a module: the styles are the host's
 * own rules copied under a `dsd-` prefix, per the bundled
 * `cordis-plugin-development` practices. The client half is served as one
 * bundle, so it stays one file.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = '@local/dsh-session-delete'
    /** Document-relative so a mount prefix survives (the shipped export route does the same). */
    const ROUTE = 'api/dsh-session-delete'
    const SHORTCUT_ID = 'session.delete'
    const ACTION_ID = 'dsh-session-delete'
    const DIALOG_ID = 'dsh-session-delete-confirm'
    const TOOLTIP_DELAY_MS = 500

    /**
     * Letter chord, like the three shipped rows that carry a chip. `Backspace`
     * is NOT registrable: `ShortcutRegistry.register` validates every declared
     * profile, and `bindingIssue` reserves the navigation keys for
     * `desktop:linux`, which has no web-runtime escape hatch — so a Backspace
     * default throws `Reserved shortcut default`. `KeyD` is free in every loaded
     * client bundle and passes all five profiles.
     */
    const SHORTCUT_DEFAULTS = {
      'desktop:macos': { code: 'KeyD', modifiers: ['primary', 'shift'] },
      'desktop:windows': { code: 'KeyD', modifiers: ['primary', 'shift'] },
      'desktop:linux': { code: 'KeyD', modifiers: ['primary', 'shift'] },
      'web:macos': { code: 'KeyD', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyD', modifiers: ['primary', 'alt'] },
    }

    const ZH = {
      'menu.deleteSession': '删除会话',
      'dialog.title': '删除会话',
      'dialog.description': '确定要永久删除「{title}」吗？',
      'dialog.warning': '会话日志、投影缓存与归档记录都会被删除。',
      'dialog.warningUndo': '此操作无法恢复。',
      'dialog.runningHint': '该会话正在运行，请先停止它再删除。',
      'dialog.pending': '删除中…',
      'shortcut.noSession': '没有正在打开的会话',
      'common.cancel': '取消',
      'common.delete': '永久删除',
      'common.close': '关闭',
      'errors.requestFailed': '删除请求失败',
    }

    const EN = {
      'menu.deleteSession': 'Delete session',
      'dialog.title': 'Delete session',
      'dialog.description': 'Permanently delete "{title}"?',
      'dialog.warning': 'The session log, its projection cache and its archive mark are all removed.',
      'dialog.warningUndo': 'This cannot be undone.',
      'dialog.runningHint': 'This session is running. Stop it before deleting.',
      'dialog.pending': 'Deleting…',
      'shortcut.noSession': 'No session is open',
      'common.cancel': 'Cancel',
      'common.delete': 'Delete permanently',
      'common.close': 'Close',
      'errors.requestFailed': 'Delete request failed',
    }

    /** Menu.module.css `.itemWrap`/`.item`/`.itemIcon`/`.shortcut` + `.danger`, prefixed. */
    const MENU_CSS = `
.dsd-itemWrap{position:relative}
.dsd-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left;font-family:inherit}
.dsd-item:hover:not(:disabled),.dsd-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}
.dsd-item:disabled{opacity:.4;cursor:not-allowed}
.dsd-itemIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon)}
.dsd-itemIcon svg{width:14px;height:14px}
.dsd-itemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsd-shortcut{flex:none;margin-inline-start:auto}
.dsd-shortcutKeys{display:inline-flex;flex:none;align-items:center;gap:3px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;white-space:nowrap}
.dsd-shortcutKey,.dsd-shortcutSep{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;font:inherit}
.dsd-danger{color:var(--dsw-alias-state-error-primary)}
.dsd-danger .dsd-itemIcon{color:var(--dsw-alias-state-error-primary)}
.dsd-danger:hover:not(:disabled),.dsd-danger:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}
`

    /** Tooltip.module.css `.bubble`, prefixed; rendered only while a bubble is visible. */
    const TOOLTIP_CSS = `
.dsd-tip{display:inline-flex;align-items:center;gap:8px;position:fixed;z-index:1100;width:max-content;max-width:50vw;padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none;animation:dsdTipIn 150ms var(--ds-ease-in-out)}
.dsd-tip[data-side=bottom]{transform:translateX(-100%)}
@keyframes dsdTipIn{from{opacity:0}}
@media (prefers-reduced-motion:reduce){.dsd-tip{animation:none}}
`

    /**
     * Modal.module.css plus Button.module.css `.button`/`.md`/`.outline` and the
     * archive dialog's `.deleteAction`/`.deleteStatus`/`.renameError`, prefixed.
     */
    const DIALOG_CSS = `
.dsd-root{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.dsd-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;backdrop-filter:var(--dsw-mask-blur)}
.dsd-mask::after{content:"";position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);animation:dsdEnter var(--ds-transition-duration) var(--ds-ease-in-out)}
.dsd-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:dsdEnter var(--ds-transition-duration) var(--ds-ease-in-out)}
.dsd-dialog:focus{outline:none}
@keyframes dsdEnter{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.dsd-mask::after,.dsd-dialog{animation:none}}
.dsd-content{display:flex;flex-direction:column;width:100%}
.dsd-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dsd-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsd-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dsd-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* keep-all forbids breaking between CJK characters (it only breaks at
   punctuation), and overflow-wrap is the escape hatch for a run that cannot
   fit — together they stop a word like 恢复 from being split into an orphan. */
.dsd-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;word-break:keep-all;overflow-wrap:break-word;color:var(--dsw-alias-label-primary)}
.dsd-body{display:flex;flex-direction:column;min-width:0;margin-top:20px;padding:0 24px}
.dsd-id{color:var(--dsw-alias-label-primary);margin:0 0 8px;font-family:var(--dsw-font-mono,monospace);font-size:13px;line-height:20px;word-break:break-all}
.dsd-warn{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;word-break:keep-all;overflow-wrap:break-word}
.dsd-warn + .dsd-warn{margin-top:2px}
.dsd-status{margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsd-error{margin-top:8px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dsd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.dsd-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;cursor:pointer;font-family:inherit}
.dsd-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsd-button:disabled{cursor:not-allowed;opacity:.4}
.dsd-delete:not(:disabled){color:var(--dsw-alias-state-error-primary)}
`

    /** Destructive color: the menu row, its icon and the hover button share it. */
    const DANGER = 'var(--dsw-alias-state-error-primary)'

    /**
     * All three rule sets live in one `<style>` this plugin owns and disposes:
     * created once for the whole plugin instead of once per rendered entry, so a
     * hovering tooltip and a re-rendering menu row never re-parse the CSS.
     */
    function installStyles() {
      const element = document.createElement('style')
      element.textContent = MENU_CSS + TOOLTIP_CSS + DIALOG_CSS
      document.head.append(element)
      return () => { element.remove() }
    }

    /** The row strip's `iconButton` geometry; only the hover color is dynamic. */
    const ROW_BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none',
      width: 16,
      height: 16,
      padding: 0,
      border: 'none',
      borderRadius: 'var(--dsw-radius-xs)',
      background: 'transparent',
      cursor: 'pointer',
    }

    /**
     * A minimal snapshot source: the shape the slot `hooks` compartment binds
     * into a `use<Key>` selector hook. `@deepseek-ai/dsh-client-store` provides
     * one, but a Harness Client package must not be imported.
     */
    function snapshotSource(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /** Host icon idiom: 16-unit viewBox, `fill:none`, per-path stroke, 1px weight. */
    const ICON_PATHS = {
      trash: [
        'M2.5 4.5H13.5',
        'M6.5 4.5V3.5C6.5 3.22386 6.72386 3 7 3H9C9.27614 3 9.5 3.22386 9.5 3.5V4.5',
        'M3 5V14C3 14.2761 3.22386 14.5 3.5 14.5H12.5C12.7761 14.5 13 14.2761 13 14V5',
        'M6.5 7.5V11.5M9.5 7.5V11.5',
      ],
      close: ['M2.5 2.5L13.5 13.5', 'M13.5 2.5L2.5 13.5'],
    }

    function icon(name, size) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        strokeWidth: 1,
      }, ICON_PATHS[name].map((d, index) => h('path', { key: index, d, stroke: 'currentColor' })))
    }

    /** Read the menu's close setter, tolerating an owner that binds no hook. */
    function useMenuCloser(useMenuOpenState) {
      if (typeof useMenuOpenState !== 'function') return () => {}
      const [, setOpen] = useMenuOpenState()
      return open => { setOpen(open) }
    }

    /** The chip `MenuItemButton` renders: muted key glyphs, `+` as a separator. */
    function shortcutChip(shortcut) {
      const keys = shortcut?.keys
      if (!Array.isArray(keys) || keys.length === 0) return null
      return h('span', { className: 'dsd-shortcut', 'aria-hidden': 'true' },
        h('span', { className: 'dsd-shortcutKeys' },
          keys.map((key, index) => h('kbd', {
            key: `${String(index)}:${String(key)}`,
            className: key === '+' ? 'dsd-shortcutSep' : 'dsd-shortcutKey',
          }, key)),
        ),
      )
    }

    /** The `"..."` menu row: archive's geometry and chip, a danger action's colors. */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, useShortcuts, requestSessionDelete, t }) {
      const setMenuOpen = useMenuCloser(useMenuOpenState)
      const shortcut = typeof useShortcuts === 'function'
        ? useShortcuts(rows => rows.find(row => row.id === SHORTCUT_ID))
        : undefined
      return h(React.Fragment, null,
        h('div', { key: 'wrap', className: 'dsd-itemWrap' },
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'dsd-item dsd-danger',
            'aria-keyshortcuts': shortcut?.aria,
            onClick: () => {
              setMenuOpen(false)
              requestSessionDelete(sessionId, displayTitle)
            },
          },
            h('span', { className: 'dsd-itemIcon' }, icon('trash', 14)),
            h('span', { className: 'dsd-itemLabel' }, t('menu.deleteSession')),
            shortcutChip(shortcut),
          ),
        ),
      )
    }

    /** The hover icon button: the strip's `iconButton` geometry + host tooltip. */
    function DeleteSessionRowButton({ sessionId, displayTitle, requestSessionDelete, t }) {
      const anchor = React.useRef(null)
      const timer = React.useRef(null)
      const [hover, setHover] = React.useState(false)
      const [tip, setTip] = React.useState(null)
      const label = t('menu.deleteSession')
      const cancel = () => {
        if (timer.current === null) return
        clearTimeout(timer.current)
        timer.current = null
      }
      const hide = () => {
        cancel()
        setHover(false)
        setTip(null)
      }
      // Pointer waits like the host tooltip; focus shows at once (focusDelayMs 0).
      const show = (delayMs) => {
        setHover(true)
        cancel()
        const place = () => {
          const rect = anchor.current?.getBoundingClientRect()
          if (rect !== undefined) setTip({ right: rect.right, bottom: rect.bottom + 8 })
        }
        if (delayMs === 0) place()
        else timer.current = setTimeout(() => { timer.current = null; place() }, delayMs)
      }
      React.useEffect(() => cancel, [])
      return h(React.Fragment, null,
        h('button', {
          key: 'button',
          ref: anchor,
          type: 'button',
          'aria-label': label,
          onMouseEnter: () => show(TOOLTIP_DELAY_MS),
          onMouseLeave: hide,
          onFocus: () => show(0),
          onBlur: hide,
          onClick: () => { requestSessionDelete(sessionId, displayTitle) },
          style: { ...ROW_BUTTON_STYLE, color: hover ? DANGER : 'var(--dsw-alias-label-tertiary)' },
        }, icon('trash', 14)),
        tip === null ? null : h('div', {
          key: 'tip',
          className: 'dsd-tip',
          'data-side': 'bottom',
          style: { left: tip.right, top: tip.bottom },
        }, label),
      )
    }

    /** The `shell.overlay` entry: nothing until a confirmation is requested. */
    function DeleteSessionDialog({ useDeleteRequest, closeConfirm, performDelete, useSessions, t }) {
      const request = useDeleteRequest(pending => pending)
      if (request === null) return null
      // Keyed so in-flight and error state die with each request.
      return h(DeleteSessionForm, { key: request.sessionId, request, closeConfirm, performDelete, useSessions, t })
    }

    /** One request's dialog, mirroring the archive dialog's `Modal` exactly. */
    function DeleteSessionForm({ request, closeConfirm, performDelete, useSessions, t }) {
      const dialog = React.useRef(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      // Guarded: a slot binding no session-list hook never pre-warns, and the
      // Host still refuses a running Session with 409.
      const running = typeof useSessions === 'function'
        ? useSessions(state => state?.byId?.[request.sessionId]?.running === true) === true
        : false
      const close = React.useCallback(() => {
        if (!busy) closeConfirm()
      }, [busy, closeConfirm])
      React.useEffect(() => {
        dialog.current?.focus()
        const onKeyDown = (event) => { if (event.key === 'Escape') close() }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [close])
      const confirm = () => {
        setBusy(true)
        setError(null)
        performDelete(request.sessionId)
          .then(() => { setBusy(false); closeConfirm() })
          .catch((reason) => {
            setBusy(false)
            setError(reason instanceof Error ? reason.message : String(reason))
          })
      }
      const action = (text, className, disabled, onClick) =>
        h('button', { type: 'button', className, disabled, onClick }, text)
      const title = request.displayTitle !== '' ? request.displayTitle : request.sessionId
      return h(React.Fragment, null,
        h('div', { key: 'root', className: 'dsd-root', role: 'presentation' },
          h('div', { className: 'dsd-mask', 'aria-hidden': 'true', onClick: close }),
          h('div', {
            ref: dialog,
            tabIndex: -1,
            className: 'dsd-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('dialog.title'),
          },
            h('div', { className: 'dsd-content' },
              h('div', { className: 'dsd-header' },
                h('h2', { className: 'dsd-title' }, t('dialog.title')),
                closeButton(t, close),
              ),
              h('p', { className: 'dsd-description' }, t('dialog.description', { title })),
              h('div', { className: 'dsd-body' },
                h('div', { className: 'dsd-id' }, request.sessionId),
                // Two short lines rather than one long sentence: the sentence sat
                // right on the 332px line limit, so a larger font size or a
                // different string could split a word and orphan its last glyph.
                h('p', { className: 'dsd-warn' }, t('dialog.warning')),
                h('p', { className: 'dsd-warn' }, t('dialog.warningUndo')),
                running ? h('p', { className: 'dsd-warn' }, t('dialog.runningHint')) : null,
                busy ? h('div', { className: 'dsd-status', role: 'status' }, t('dialog.pending')) : null,
                error === null ? null : h('div', { className: 'dsd-error', role: 'alert' }, error),
              ),
            ),
            h('div', { className: 'dsd-footer' },
              action(t('common.cancel'), 'dsd-button', busy, close),
              action(t('common.delete'), 'dsd-button dsd-delete', busy || running, confirm),
            ),
          ),
        ),
      )
    }

    /** The close button needs its glyph; `action` stays text-only. */
    function closeButton(t, onClose) {
      return h('button', { type: 'button', className: 'dsd-close', 'aria-label': t('common.close'), onClick: onClose }, icon('close', 14))
    }

    /** The Session the main view retains: the target the archive shortcut uses. */
    function retainedSession(ctx) {
      const byId = ctx.sessions.list.getSnapshot()?.byId
      if (byId === null || byId === undefined) return undefined
      for (const row of Object.values(byId)) {
        if (row !== null && row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) {
          return { id: row.id, displayTitle: typeof row.displayTitle === 'string' ? row.displayTitle : '' }
        }
      }
      return undefined
    }

    /**
     * The delete command, declared exactly as `ui-workspace` declares
     * `session.archive`: `shortcuts` is a required injected service (see
     * `inject` below), the command goes in through it inside an effect, and the
     * resolver captures its target synchronously.
     */
    function deleteShortcut(t, openConfirm, ctx) {
      return {
        id: SHORTCUT_ID,
        label: () => t('menu.deleteSession'),
        aliases: ['delete session'],
        defaults: SHORTCUT_DEFAULTS,
        // Same input ownership as `session.archive`: a destructive row still only
        // opens a confirmation, so it must answer while the composer has focus —
        // otherwise the chip advertises a chord that does nothing where the user
        // usually is.
        regions: ['page', 'editable'],
        modals: [],
        resolve: () => {
          const target = retainedSession(ctx)
          if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
          return { status: 'handled', run: () => openConfirm(target.id, target.displayTitle) }
        },
      }
    }

    return {
      // `shortcuts` and `sessions` are required injected services, exactly as
      // `ui-workspace` declares them: reading an undeclared service (property or
      // `ctx.get`) does not resolve, and the archive shortcut's own registration
      // goes through the injected service.
      inject: ['slots', 'locale', 'shortcuts', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-session-delete: dictionaries')
        ctx.effect(installStyles, 'dsh-session-delete: styles')
        const t = ctx.locale.bind(NS)

        const deleteRequest = snapshotSource(null)
        const openConfirm = (sessionId, displayTitle) => deleteRequest.set({
          sessionId,
          displayTitle: typeof displayTitle === 'string' ? displayTitle : '',
        })
        const closeConfirm = () => { deleteRequest.set(null) }
        const performDelete = async (sessionId) => {
          const failure = (detail) => new Error(`${t('errors.requestFailed')}${detail}`)
          let response
          try {
            response = await fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            })
          } catch (reason) {
            throw failure(`: ${reason instanceof Error ? reason.message : String(reason)}`)
          }
          const payload = await response.json().catch(() => null)
          if (response.ok && payload?.ok === true) return payload
          const detail = typeof payload?.message === 'string' ? `: ${payload.message}` : ''
          throw failure(` (HTTP ${String(response.status)})${detail}`)
        }

        // Exactly the archive registration: the injected service, one effect.
        ctx.effect(
          () => ctx.shortcuts.register(deleteShortcut(t, openConfirm, ctx)),
          `dsh-session-delete: ${SHORTCUT_ID}`,
        )

        const chip = () => ({ t, requestSessionDelete: openConfirm })
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item', id: ACTION_ID, order: 500, inject: chip,
        }, DeleteSessionMenuItem))

        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action', id: ACTION_ID, order: 300, inject: chip,
        }, DeleteSessionRowButton))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: DIALOG_ID,
          label: () => t('dialog.title'),
          inject: () => ({ t, hooks: { deleteRequest }, closeConfirm, performDelete }),
        }, DeleteSessionDialog))
      },
    }
  },
})
