// fMess: keeps the window on Messenger chats, hides Facebook's top bar there,
// and hands web notifications to the OS notification center.
// Runs at document start, before the page's scripts.
(() => {
  if (window.top !== window || window.__fmessInstalled) return;
  window.__fmessInstalled = true;

  // WebView2 (Windows) runs this before the page has its <html> element;
  // WebKit already has one. What needs it waits for it.
  const withRoot = (use) => {
    if (document.documentElement) return use(document.documentElement);
    const wait = new MutationObserver(() => {
      if (!document.documentElement) return;
      wait.disconnect();
      use(document.documentElement);
    });
    wait.observe(document, { childList: true });
  };

  // fMess's loading screen in place of Facebook's, in Messenger's colours
  // (set by fMess before this script), until the chat list is up. Login and
  // other pages show at once.
  if (!window.opener && window.__fmessSplashLogo && /^\/messages(\/|$)/.test(location.pathname)) {
    const dark = window.__fmessDark ?? matchMedia('(prefers-color-scheme: dark)').matches;
    const splashStyle = document.createElement('style');
    splashStyle.textContent = `
      #fmess-splash {
        position: fixed;
        inset: 0;
        /* Below only the window's drag strip. */
        z-index: 2147483646;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
        background: ${dark ? '#1c1c1d' : '#ffffff'};
        color: ${dark ? '#e4e6eb' : '#050505'};
        font: 600 22px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        letter-spacing: -0.01em;
        transition: opacity 0.3s ease;
      }
      #fmess-splash.done { opacity: 0; pointer-events: none; }
      #fmess-splash img { width: 112px; height: 112px; animation: fmess-breathe 1.8s ease-in-out infinite; }
      #fmess-splash i {
        position: relative;
        width: 120px;
        height: 3px;
        margin-top: 6px;
        border-radius: 2px;
        overflow: hidden;
        background: ${dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)'};
      }
      #fmess-splash i::after {
        content: '';
        position: absolute;
        inset: 0;
        width: 40%;
        border-radius: 2px;
        background: #ff6a13;
        animation: fmess-slide 1.1s ease-in-out infinite;
      }
      @keyframes fmess-breathe { 50% { transform: scale(0.95); } }
      @keyframes fmess-slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
    `;
    const splash = document.createElement('div');
    splash.id = 'fmess-splash';
    splash.innerHTML = `<img alt="" src="${window.__fmessSplashLogo}"><span>fMess</span><i></i>`;
    withRoot((root) => root.append(splashStyle, splash));
    const shownAt = Date.now();
    const waitForChats = setInterval(() => {
      const ready =
        document.querySelector('[role="grid"] [role="row"]') ||
        document.querySelector('input[name="email"], input[name="pass"]') ||
        !/^\/messages(\/|$)/.test(location.pathname) ||
        Date.now() - shownAt > 20000;
      if (!ready) return;
      clearInterval(waitForChats);
      splash.classList.add('done');
      setTimeout(() => (splash.remove(), splashStyle.remove()), 400);
    }, 100);
  }

  // A few of Facebook's own modules are adjusted as its loader (window.__d)
  // defines them. Each patch checks the module's shape first and leaves it
  // alone if Facebook changed it.
  //
  // Calls in end-to-end encrypted chats need a frame transform. Facebook ships
  // one for WebKit (RTCRtpScriptTransform) but keeps it behind gatekeeper
  // 16078, and otherwise only accepts Chrome's createEncodedStreams, so every
  // WebKit call button says "not supported on this browser". fMess answers
  // that gatekeeper itself; its settings can turn this off.
  //
  // Notifications: Messenger raises full ones (sender, text, picture; clicking
  // opens the chat) only when it runs as an installed app on messenger.com and
  // the page is hidden. fMess is such an app, and like the old desktop app it
  // counts as away whenever its window isn't the active one. Only that one
  // check changes (FACTORY_REWRITES); patching isMessengerPWA or VisibilityAPI
  // themselves changed far more of the page and made it sluggish.
  // fMess passes its settings in before this script (window.__fmessSettings);
  // a change to this one reloads the page and comes through localStorage.
  const settings = window.__fmessSettings ?? {};
  let macCalls = settings.macCalls !== false;
  try {
    const changed = localStorage.getItem('fmess.macCalls');
    if (changed !== null) macCalls = changed !== '0';
  } catch {}
  const FORCED_GATES = macCalls ? { 16078: true } : {};
  const MODULE_PATCHES = {
    gkx(exports) {
      const gkx = exports.default;
      if (typeof gkx?.add !== 'function') return false;
      exports.default = Object.assign(
        (id) => (Object.hasOwn(FORCED_GATES, id) ? FORCED_GATES[id] : gkx(id)),
        gkx,
      );
      return true;
    },
    // Facebook pops its own notifications (group posts, likes) over the page
    // unless the route asks it not to; in fMess no route wants them. The
    // notifications under the bell in Facebook's top bar stay.
    useHideNotificationsToasts(exports) {
      if (typeof exports.default !== 'function') return false;
      exports.default = () => true;
      return true;
    },
    // Messenger's notification for a new message carries only a title, text
    // and one picture. The old desktop app showed the sender and, in a group,
    // the group with its picture, and kept each chat's notifications
    // together; fMess reads those details the way this module does.
    MWDesktopNotifications(exports) {
      const trigger = exports.triggerLocalNotification;
      if (typeof trigger !== 'function') return false;
      exports.triggerLocalNotification = function (db, message, ...rest) {
        const notify = () => {
          const details = readMessageDetails(db, message).catch(() => null);
          messageDetails.set(String(message?.messageId), details);
          if (messageDetails.size > 50) messageDetails.delete(messageDetails.keys().next().value);
          return trigger.call(this, db, message, ...rest);
        };
        // A computer back from sleep gets the messages it missed one by one,
        // and Messenger would notify about each, read elsewhere or not.
        return isOldNews(db, message).then((old) => (old ? undefined : notify()), notify);
      };
      return true;
    },
    // Messenger's dark mode is React state at the root of the page. fMess's
    // Settings change it with the setter Messenger's own Preferences use, read
    // from inside that provider, so the page switches at once.
    'makeCometDarkModeStateProvider.react'(exports) {
      const make = exports.default;
      if (typeof make !== 'function' || make.length !== 1) return false;
      exports.default = (options) => {
        const Provider = make(options);
        const React = window.require('react');
        const contextModule = window.require('CometDarkModeContext');
        const context = contextModule?.$$typeof ? contextModule : contextModule?.default;
        const ReadSetter = () => {
          window.__fmessSetDarkMode = React.useContext(context).setDarkModeSetting;
          return null;
        };
        return (props) => React.createElement(Provider, props, React.createElement(ReadSetter), props.children);
      };
      return true;
    },
  };
  // Rewrites of a module's source, each replacing exactly one match. The page
  // forbids eval but allows blob: scripts, so the rewritten factory loads as
  // one; modules run only when first required, by which time it is there.
  // Until then, or if a pattern no longer matches, the original runs.
  const FACTORY_REWRITES = {
    useMWLSChatPopperUpper: [
      [/(\w+)\("VisibilityAPI"\)\.isVisibilityHidden\(\)===!0/, '($1("VisibilityAPI").isVisibilityHidden()===!0||!document.hasFocus())'],
      [/\w+\("isMessengerPWA"\)\(\)&&\w+\("justknobx"\)\._\("1465"\)/, '!0'],
    ],
  };
  const rewrittenFactories = {};
  const rewriteFactory = (name, factory) => {
    let source = factory.toString();
    for (const [pattern, replacement] of FACTORY_REWRITES[name]) {
      if (source.match(new RegExp(pattern.source, 'g'))?.length !== 1) return;
      source = source.replace(pattern, replacement);
    }
    const key = `fmess:${name}`;
    const script = document.createElement('script');
    script.src = URL.createObjectURL(
      new Blob([`window[${JSON.stringify(key)}] = (${source});`], { type: 'text/javascript' }),
    );
    script.onload = () => {
      rewrittenFactories[name] = window[key];
      delete window[key];
      URL.revokeObjectURL(script.src);
      script.remove();
    };
    (document.head || document.documentElement).append(script);
  };
  let defineModule;
  Object.defineProperty(window, '__d', {
    configurable: true,
    get: () => defineModule,
    set(loaderDefine) {
      defineModule = function (name, deps, factory, ...rest) {
        if (typeof factory === 'function' && Object.hasOwn(FACTORY_REWRITES, name)) {
          const originalFactory = factory;
          rewriteFactory(name, originalFactory);
          factory = function (...args) {
            return (rewrittenFactories[name] ?? originalFactory).apply(this, args);
          };
        } else if (typeof factory === 'function' && Object.hasOwn(MODULE_PATCHES, name)) {
          const patch = MODULE_PATCHES[name];
          const originalFactory = factory;
          factory = function (...args) {
            const result = originalFactory.apply(this, args);
            args.some((arg) => arg && typeof arg === 'object' && arg !== window && patch(arg));
            return result;
          };
          // The loader passes a factory's extra arguments (fbt, for one) only
          // when it declares them.
          Object.defineProperty(factory, 'length', { value: originalFactory.length });
        }
        return loaderDefine.call(this, name, deps, factory, ...rest);
      };
    },
  });

  // WKWebView ignores window.close(), so the Close button of a call window did
  // nothing. Navigate to a URL fMess watches for instead; it closes the window
  // (and ignores the request in the main window). See CLOSE_WINDOW_URL in webview.rs.
  window.close = () => {
    location.href = 'fmess://close-window';
  };

  // Privacy (fMess Settings): don't let people see that you're typing.
  //
  // Messenger sends requests over the /ws/lightspeed WebSocket. A frame holds
  // parts: a type byte and a 2-byte stream id, then, except in the part that
  // closes a stream (0x0e), a 3-byte length and that many bytes; all little
  // endian. Each request has a stream of its own, and its data part (0x0d) is
  // two flag bytes and the request as JSON, nesting more JSON in strings.
  // Requests are edited rather than dropped, so every stream still gets its
  // answer and nothing is retried: typing (type 4, label "3") says
  // is_typing 0. Typing in encrypted chats goes to Messenger's worker instead
  // (sendChatStateFromComposer) and is edited on its way there.
  const privacy = { blockTyping: Boolean(settings.blockTyping) };

  const currentUserId = () => {
    try {
      return window.require('CurrentUserInitialData').USER_ID || null;
    } catch {
      return null;
    }
  };
  const parseJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  // Edits the JSON object in text with edit(value), which returns true when it
  // changed something; null when nothing changed. Ids are 64-bit numbers, so
  // only JSON that a parse and stringify give back unchanged is edited.
  const editJson = (text, edit) => {
    const value = parseJson(text);
    if (!value || typeof value !== 'object' || JSON.stringify(value) !== text) return null;
    return edit(value) ? JSON.stringify(value) : null;
  };
  // Same for object[key], which may hold the JSON as a string.
  const editNested = (object, key, edit) => {
    const value = object?.[key];
    if (value && typeof value === 'object') return edit(value);
    const edited = typeof value === 'string' ? editJson(value, edit) : null;
    if (edited === null) return false;
    object[key] = edited;
    return true;
  };

  const TYPING_LABEL = '3';
  const editRequest = (request) => {
    if (request.type === 4 && privacy.blockTyping) {
      return editNested(
        request,
        'payload',
        (update) =>
          update.label === TYPING_LABEL &&
          editNested(update, 'payload', (typing) => {
            if (!typing.is_typing) return false;
            typing.is_typing = 0;
            return true;
          }),
      );
    }
    return false;
  };
  const PART_DATA = 0x0d;
  const PART_CLOSE = 0x0e;
  // The frame with its requests edited, or null when nothing changed.
  const editFrame = (bytes) => {
    const parts = [];
    let edited = false;
    for (let pos = 0; pos < bytes.length; ) {
      if (bytes[pos] === PART_CLOSE) {
        parts.push(bytes.subarray(pos, pos + 3));
        pos += 3;
        continue;
      }
      if (pos + 6 > bytes.length) return null;
      const end = pos + 6 + (bytes[pos + 3] | (bytes[pos + 4] << 8) | (bytes[pos + 5] << 16));
      if (end > bytes.length) return null;
      let part = bytes.subarray(pos, end);
      const json = bytes[pos] === PART_DATA && end > pos + 8 ? new TextDecoder().decode(bytes.subarray(pos + 8, end)) : null;
      const request = json && editJson(json, editRequest);
      if (request) {
        const encoded = new TextEncoder().encode(request);
        const length = encoded.length + 2;
        part = new Uint8Array(8 + encoded.length);
        part.set(bytes.subarray(pos, pos + 3));
        part.set([length & 0xff, (length >> 8) & 0xff, length >> 16], 3);
        part.set(bytes.subarray(pos + 6, pos + 8), 6);
        part.set(encoded, 8);
        edited = true;
      }
      parts.push(part);
      pos = end;
    }
    if (!edited) return null;
    const frame = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    parts.reduce((offset, part) => (frame.set(part, offset), offset + part.length), 0);
    return frame;
  };
  const nativeSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const bytes =
      !privacy.blockTyping || !String(this.url).includes('/ws/lightspeed')
        ? null
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : null;
    return nativeSend.call(this, (bytes && editFrame(bytes)) || data);
  };
  // Requests to the worker are batches: [{type: 'request', content: {name, arg}}].
  const CHAT_STATE = 'sendChatStateFromComposer';
  const CHAT_IDLE = 'idle';
  const nativePostMessage = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message, ...rest) {
    if (privacy.blockTyping && Array.isArray(message) && message.some((item) => item?.content?.name === CHAT_STATE)) {
      // Seen so far: typing and idle. Anything but idle shows the dots.
      message = message.map((item) =>
        item?.content?.name === CHAT_STATE && item.content.arg?.state !== CHAT_IDLE
          ? { ...item, content: { ...item.content, arg: { ...item.content.arg, state: CHAT_IDLE } } }
          : item,
      );
    }
    return nativePostMessage.call(this, message, ...rest);
  };

  // Loads Facebook modules on demand; a name Facebook dropped would never call back.
  const loadModules = (names) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`could not load ${names.join(', ')}`)), 10000);
      window.require('Bootloader').loadModules(names, () => (clearTimeout(timer), resolve()), 'fmess');
    });
  const moduleFunction = (module) => (typeof module === 'function' ? module : module.default);
  // Lightspeed keeps 64-bit numbers as [high, low], and keys rows by their id
  // that way (an account's settings, a contact, a chat).
  const int64 = (value) => (Array.isArray(value) ? (BigInt(value[0]) << 32n) + BigInt(value[1] >>> 0) : BigInt(value ?? 0));
  const int64Key = (id) => [Number(BigInt(id) >> 32n), Number(BigInt(id) & 0xffffffffn)];
  const serverNow = () => {
    try {
      return window.require('ServerTime').getMillis();
    } catch {
      return Date.now();
    }
  };
  // Messages that arrive this late aren't news (see isOldNews).
  const LATE_MS = 2 * 60 * 1000;

  // The rest of Messenger's Preferences (⋯ → Preferences) belong to the
  // account as well. fMess's Settings show them: the page reads them here
  // and reports them when they may have changed, and changes them the way
  // that dialog does (__fmessSetMessengerPref).
  // Some of the modules involved come only with the code of that dialog, which
  // Messenger loads when it first opens; fMess loads it the same way.
  const loadPreferences = async () => {
    await loadModules(['MWInboxSettingsDialog.entrypoint']);
    await window.require('MWInboxSettingsDialog.entrypoint').root.load();
  };
  const PREF_MODULES = ['CometRelayEnvironment', 'relay-runtime', 'resolveActiveStatus', 'CometDarkMode', 'LSDatabaseSingleton'];
  const readMessengerPrefs = async () => {
    const me = currentUserId();
    if (!me) return null;
    await loadPreferences();
    await loadModules(PREF_MODULES);
    const [env, relay, resolveActiveStatus, darkMode, database] = PREF_MODULES.map((name) => window.require(name));
    const query = window.require('useCometHomeChatSettingsQuery.graphql');
    const { viewer } = (await relay.fetchQuery(env, query, {}, { fetchPolicy: 'store-or-network' }).toPromise()) ?? {};
    const db = await database.LSDatabaseSingleton;
    const notifications = await db.tables.notification_settings.get(int64Key(me));
    // Right after loading, Messenger may not have synced its settings yet.
    if (!notifications) return null;
    return {
      soundsOn: viewer?.chat_sounds_on ?? true,
      activeStatusOn: viewer
        ? moduleFunction(resolveActiveStatus)(viewer.chat_visibility, viewer.chat_visibility_on_messenger, viewer.chat_visibility_on_facebook)
        : null,
      // Seconds since 1970 when Do Not Disturb ends: 0 when off, -1 until turned off.
      muteUntil: Number(int64(notifications.globalMuteUntil)),
      darkMode: darkMode.getDarkModeSetting(),
    };
  };
  let messengerPrefs = null;
  let reportedPrefs = '';
  // Messenger also keeps Do Not Disturb for this computer's notifications in
  // IndexedDB, and leaves the end time there when Do Not Disturb runs out;
  // clear it the way turning it off in Messenger does.
  let clearedLocalMute = false;
  const clearLocalMute = async () => {
    clearedLocalMute = true;
    await loadModules(['MessengerNotificationsWriter']);
    window.require('MessengerNotificationsWriter').updateMute(currentUserId(), 0);
  };
  // Whether the preferences could be read.
  // Whether Messenger is dark: its own setting, or the system's when it follows
  // the system (Facebook then marks only parts of the page). Themes key their
  // dark colours on it: html[data-fmess-dark].
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const syncDark = () => {
    const setting = messengerPrefs?.darkMode;
    const dark =
      setting === 'ENABLED' || (setting === 'DISABLED' ? false : setting === 'USE_SYSTEM' ? systemDark.matches : (window.__fmessDark ?? systemDark.matches));
    withRoot((root) => root.toggleAttribute('data-fmess-dark', Boolean(dark)));
  };
  syncDark();
  systemDark.addEventListener('change', syncDark);
  const reportMessengerPrefs = async () => {
    const prefs = await readMessengerPrefs().catch(() => null);
    if (!prefs) return false;
    messengerPrefs = prefs;
    syncDark();
    if (!isMuted() && !clearedLocalMute) clearLocalMute().catch(() => {});
    const json = JSON.stringify(prefs);
    if (json === reportedPrefs) return true;
    reportedPrefs = json;
    window.__TAURI_INTERNALS__?.invoke('sync_messenger_prefs', { prefs }).catch(() => {});
    return true;
  };
  // Right after loading they may not be there yet: try every few seconds.
  const reportOnceRead = async (tries = 0) => {
    if (!(await reportMessengerPrefs()) && tries < 20) setTimeout(() => reportOnceRead(tries + 1), 3000);
  };
  if (!window.opener) {
    window.addEventListener('load', () => {
      setTimeout(reportOnceRead, 2000);
      // A new dark mode setting (from fMess's Settings, Messenger's own
      // Preferences or the phone) recolours fMess's windows at once.
      loadModules(['CometDarkMode'])
        .then(() => window.require('CometDarkMode').onDarkModeChange(() => reportMessengerPrefs()))
        .catch(() => {});
    });
    window.addEventListener('focus', reportMessengerPrefs);
    setInterval(reportMessengerPrefs, 30000);
  }
  const isMuted = () => {
    const until = messengerPrefs?.muteUntil ?? 0;
    return until < 0 || until * 1000 > Date.now();
  };
  // Messenger still plays its message sound during Do Not Disturb; fMess
  // keeps it quiet. Its sounds are <audio> files (SoundPlayer); call audio is
  // a stream, and ringing loops, so calls still ring.
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (this instanceof HTMLAudioElement && this.src && !this.loop && isMuted()) return Promise.resolve();
    return nativePlay.apply(this, args);
  };
  // Do Not Disturb for ms milliseconds; -1 until turned off, 0 turns it off.
  const muteFor = async (ms) => {
    const names = ['I64', 'ServerTime', 'LSDatabaseSingleton', 'LSFactory', 'MessengerNotificationsWriter'];
    await loadPreferences();
    await loadModules(names);
    const [I64, serverTime, database, factory, writer] = names.map((name) => window.require(name));
    const update = window.require('LSOptimisticallyUpdateGlobalMuteUntilStoredProcedure');
    const until = ms === 0 ? I64.zero : ms < 0 ? I64.neg_one : I64.of_float((serverTime.getMillis() + ms) / 1e3);
    const db = await database.LSDatabaseSingleton;
    await db.runInTransaction((tx) => moduleFunction(update)(moduleFunction(factory)(tx), { globalMuteUntil: until }), 'readwrite');
    // What Messenger's push notifications on this computer check.
    writer.updateMute(currentUserId(), ms === 0 ? 0 : I64.to_float(until));
  };
  // Called by fMess's Settings.
  window.__fmessSetMessengerPref = async (name, value) => {
    try {
      if (name === 'soundsOn') {
        await loadPreferences();
        await loadModules(['CometRelayEnvironment']);
        await window.require('MWChatChangeSoundsSettingMutation').commit(window.require('CometRelayEnvironment'), { sounds_on: Boolean(value) });
      } else if (name === 'darkMode') {
        if (window.__fmessSetDarkMode) {
          window.__fmessSetDarkMode(value);
        } else {
          // Saved, but the page keeps its look until it reloads.
          await loadModules(['CometDarkMode']);
          window.require('CometDarkMode').saveDarkModeSetting(value, { onRevert() {} });
        }
      } else if (name === 'muteFor') {
        await muteFor(Number(value));
      }
    } catch (error) {
      console.warn('[fMess] could not change', name, error);
    }
    reportedPrefs = '';
    setTimeout(reportMessengerPrefs, 1000);
  };
  // Opens Messenger's own Preferences, or its Active Status page, for what
  // fMess's Settings leave to it (Active Status keeps lists of people).
  window.__fmessOpenMessengerPreferences = async (section) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const find = async (test) => {
      for (let waited = 0; waited < 8000; waited += 200) {
        const found = test();
        if (found) return found;
        await wait(200);
      }
      return null;
    };
    let header = document.querySelector('a[href="/messages/new/"]');
    while (header && !header.querySelector('h1')) header = header.parentElement;
    header && [...header.querySelectorAll('[role="button"]')].find((el) => !el.closest('a') && el.id !== 'fmess-account')?.click();
    // Preferences heads the ⋯ menu.
    const item = await find(() => {
      const items = [...document.querySelectorAll('[role="menuitem"], [role="menu"] [role="button"]')];
      return items.find((el) => /^(preferences|tùy chọn|tuỳ chọn)$/i.test((el.innerText || '').trim())) ?? items[0];
    });
    item?.click();
    if (section !== 'activeStatus') return;
    // The Preferences dialog is the one with the dark mode choices; Active
    // Status is its first button with text (after the profile link).
    const dialog = await find(() => [...document.querySelectorAll('[role="dialog"]')].find((el) => el.querySelector('input[type="radio"]')));
    if (!dialog) return;
    [...dialog.querySelectorAll('[role="button"]')].find((el) => (el.innerText || '').trim())?.click();
  };

  // Facebook is a single-page app, so moving between chats and the rest of
  // Facebook happens through the History API rather than real navigations.
  const CHATS = 'data-fmess-chats';
  // The chats, and the photo/video viewer opened from them.
  const onChatsPage = () => /^\/(messages|messenger_media)(\/|$)/.test(location.pathname);
  let lastPath = null;
  const MEDIA = 'data-fmess-media';
  let viewerOpen = false;
  let viewerCloseTimer;
  const syncRoute = () => {
    document.documentElement.toggleAttribute(CHATS, onChatsPage());
    const inViewer = location.pathname.startsWith('/messenger_media');
    document.documentElement.toggleAttribute(MEDIA, inViewer);
    if (inViewer !== viewerOpen) {
      viewerOpen = inViewer;
      clearInterval(viewerCloseTimer);
      if (inViewer) viewerCloseTimer = setInterval(() => (placeViewerClose(), dropStaleZoom()), 100);
      else resetZoom();
      // On macOS fMess gives the photo/video viewer a regular title bar, so
      // the viewer lays itself out below the window buttons as in a browser.
      setTimeout(() => window.__TAURI_INTERNALS__?.invoke('set_viewer_open', { open: inViewer }).catch(() => {}));
    }
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (/^\/messages\/(e2ee\/)?t\//.test(lastPath)) {
        focusComposer();
        // Defined further down, after this first runs.
        setTimeout(() => clearOpenChatNotifications());
      }
    }
  };

  // Opening a chat puts the cursor in its message box, as the desktop app
  // did, instead of needing another click. The old chat's box is still on
  // screen for a moment, so wait for a different one (or give up waiting).
  const composer = () => document.querySelector('[role="main"] [contenteditable="true"][role="textbox"]');
  let focusTimer;
  function focusComposer() {
    clearInterval(focusTimer);
    const previous = composer();
    let tries = 0;
    focusTimer = setInterval(() => {
      tries += 1;
      const box = composer();
      if ((box && (box !== previous || tries > 10)) || tries > 60) {
        clearInterval(focusTimer);
        if (box && document.activeElement !== box) box.focus();
      }
    }, 50);
  }
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      syncRoute();
      return result;
    };
  }
  window.addEventListener('popstate', syncRoute);
  withRoot(syncRoute);

  // Facebook links in a chat (reels, posts, profiles) open in the browser, so
  // fMess stays on the conversation. Keep this list in step with
  // IN_APP_PATHS in links.rs, which handles the window.open() below.
  const IN_APP_PATHS = ['/messages', '/messenger_media', '/groupcall', '/videocall'];
  const isFacebookHost = (host) =>
    ['facebook.com', 'messenger.com'].some((domain) => host === domain || host.endsWith(`.${domain}`));
  document.addEventListener(
    'click',
    (event) => {
      if (!onChatsPage() || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link) return;
      const url = new URL(link.href, location.href);
      if (!isFacebookHost(url.hostname) || IN_APP_PATHS.some((path) => url.pathname.startsWith(path))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.open(url.href, '_blank', 'noopener');
    },
    true,
  );

  // Layout, closer to the old desktop app.
  //
  // Facebook's top bar is a zero-height role="banner" wrapper around fixed
  // navigation, and the page leaves room for it through --header-height.
  // Themed subtrees declare that variable again, so set it on every element.
  // In the chats the bar is hidden; elsewhere it stays, so there is always a
  // way back.
  //
  // On macOS the title bar overlays the page (set by fMess before this
  // script), so the page keeps a strip of __fmessTitleBarInset pixels free
  // for the window buttons and dragging, and the bar moves below it.
  //
  // The chats lose the inset, rounded cards Facebook draws, so the panes sit
  // edge to edge with a divider, as in the old app.
  const LOGGED_OUT = 'data-fmess-logged-out';
  const syncLoggedOut = () => {
    let out = false;
    try {
      out = String(window.require('CurrentUserInitialData').USER_ID) === '0';
    } catch {}
    document.documentElement?.toggleAttribute(LOGGED_OUT, out);
  };
  setInterval(syncLoggedOut, 1000);
  // Popups (call windows) keep a normal title bar.
  const titleBarInset = window.opener ? 0 : window.__fmessTitleBarInset || 0;
  const inset = `${titleBarInset}px`;
  const BAR_HIDDEN = `html[${CHATS}]`;
  const BAR_SHOWN = `html:not([${CHATS}])`;
  const layoutStyle = document.createElement('style');
  layoutStyle.textContent = `
    ${BAR_HIDDEN} div[role="banner"] { display: none !important; }
    ${BAR_HIDDEN}, ${BAR_HIDDEN} * { --header-height: ${inset} !important; }
    :is(${BAR_SHOWN}) div[role="banner"] { transform: translateY(${inset}); }
    :is(${BAR_SHOWN}), :is(${BAR_SHOWN}) * { --header-height: calc(56px + ${inset}) !important; }
    /* Logged out, Facebook's pages have no top bar to make room for. */
    html[${LOGGED_OUT}], html[${LOGGED_OUT}] * { --header-height: ${inset} !important; }
    html[${CHATS}], html[${CHATS}] * {
      --messenger-card-spacing: 0px !important;
      --messenger-card-corner-radius: 0px !important;
      --messenger-card-box-shadow: none !important;
    }
    html[${CHATS}] [role="main"] { box-shadow: -1px 0 0 var(--divider, var(--card-border-color)); }
    /* The same divider before the chat's details (the pane beside the
       messages, with the Search button). */
    html[${CHATS}] [role="main"] div:has([role="log"]) > div:has([role="list"]):has([aria-label="Search"]):not(:has([role="log"])) {
      box-shadow: -1px 0 0 var(--divider, var(--card-border-color));
    }
    /* The photo/video viewer centres its top bar (close, download, forward)
       in a band --header-height tall, made for Facebook's 56px bar; without
       it the buttons sit off the top. The viewer gets a regular title bar
       on macOS (see syncRoute), so it needs no drag strip either. */
    html[${MEDIA}] [role="dialog"], html[${MEDIA}] [role="dialog"] * { --header-height: 56px !important; }
    html[${MEDIA}] [data-tauri-drag-region] { display: none; }
    /* Facebook shows the viewer's close button and logo in its top bar,
       which fMess hides, and keeps the viewer's own copy transparent. Show
       that copy's close button (placeViewerClose moves it) without the logo. */
    html[${MEDIA}] [role="dialog"] > div:has(> a[href="/"]) {
      opacity: 1 !important;
      /* Above the dark gradient the viewer lays over the photo's top edge,
         which download and forward sit above too; under it, close looked grey. */
      z-index: 2147483000 !important;
    }
    html[${MEDIA}] [role="dialog"] > div:has(> a[href="/"]) > a[href="/"] { display: none !important; }
    /* Its thin X looks out of place beside the solid download and forward
       icons; draw a bold white one instead (the viewer is always dark; a
       masked currentColor rendered grey in WebKit). */
    html[${MEDIA}] [role="dialog"] > div:has(> a[href="/"]) [role="button"] svg { display: none !important; }
    html[${MEDIA}] [role="dialog"] > div:has(> a[href="/"]) [role="button"]::after {
      content: '';
      width: 20px;
      height: 20px;
      background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath d='M5.5 5.5l9 9M14.5 5.5l-9 9' stroke='white' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E") center / contain no-repeat;
    }
    /* Download and forward show their name on hover; so does close, using
       the label Facebook gives it (translated with the rest of the page). */
    html[${MEDIA}] [role="dialog"] > div:has(> a[href="/"]) [role="button"]::before {
      content: attr(aria-label);
      position: absolute;
      top: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      padding: 6px 10px;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.8);
      color: #fff;
      font: 12px/16px system-ui, -apple-system, sans-serif;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s;
    }
    html[${MEDIA}] [role="dialog"] > div:has(> a[href="/"]) [role="button"]:hover::before { opacity: 1; }
    /* WebKit takes about 4 s per layout for a 100%-height image inside an
       aspect-ratio flex box (photos in shared-post previews), which froze
       whole chats. Auto height looks the same there and takes milliseconds. */
    html[${CHATS}] img[height="100%"][width="100%"] { height: auto !important; }
  `;
  withRoot((root) => root.append(layoutStyle));

  // A double or triple click selects a whole message and the break after it,
  // and WebKit then fills the space under its last line down to the edge of
  // the bubble. WebKit fills only what can be selected, so the messages can't
  // be, and their text still can.
  const selectStyle = document.createElement('style');
  selectStyle.textContent = `
    html[${CHATS}] [data-message-id] { -webkit-user-select: none !important; user-select: none !important; }
    html[${CHATS}] [data-message-id] [dir="auto"] { -webkit-user-select: text !important; user-select: text !important; }
  `;
  withRoot((root) => root.append(selectStyle));
  if (titleBarInset) {
    const dragStrip = document.createElement('div');
    dragStrip.setAttribute('data-tauri-drag-region', '');
    dragStrip.style.cssText = `position: fixed; inset: 0 0 auto 0; height: ${inset}; z-index: 2147483647;`;
    withRoot((root) => root.append(dragStrip));
  }

  // Scrollbars like macOS overlay scrollbars: WebKit draws always-on gray
  // tracks when the system shows scroll bars, and even a styled scrollbar
  // takes room from the content (selected chats stopped short of the edge).
  // So fMess's window hides real scrollbars and floats a thin indicator over
  // the scrolling pane while it moves; call windows keep WebKit's. Wheel and
  // trackpad scrolling are unchanged.
  const MAIN = 'data-fmess-main';
  if (!window.opener) withRoot((root) => root.setAttribute(MAIN, ''));
  const scrollStyle = document.createElement('style');
  scrollStyle.textContent = `
    html[${MAIN}], html[${MAIN}] * { scrollbar-width: none !important; }
    html[${MAIN}] ::-webkit-scrollbar, html[${MAIN}]::-webkit-scrollbar { width: 0; height: 0; }
    #fmess-scroll-indicator {
      position: fixed; z-index: 2147483646; width: 6px; border-radius: 3px;
      background: rgba(128, 128, 128, 0.55); pointer-events: none;
      opacity: 0; transition: opacity 0.3s;
    }
  `;
  withRoot((root) => root.append(scrollStyle));
  const indicator = document.createElement('div');
  indicator.id = 'fmess-scroll-indicator';
  withRoot((root) => root.append(indicator));
  let hideIndicator;
  document.addEventListener(
    'scroll',
    (event) => {
      const scroller = event.target;
      if (window.opener || !(scroller instanceof Element)) return;
      const range = scroller.scrollHeight - scroller.clientHeight;
      if (range <= 1) return;
      const box = scroller.getBoundingClientRect();
      const height = Math.max(24, (box.height * scroller.clientHeight) / scroller.scrollHeight);
      const top = box.top + ((box.height - height) * scroller.scrollTop) / range;
      // The indicator floats above the whole page, so it stays hidden where
      // a menu or dialog covers the pane (it lets points through to them).
      const covered = [top + 2, top + height / 2, top + height - 2].some((y) => {
        const el = document.elementFromPoint(box.right - 6, y);
        return el && !scroller.contains(el);
      });
      if (covered) {
        clearTimeout(hideIndicator);
        indicator.style.opacity = '0';
        return;
      }
      Object.assign(indicator.style, {
        left: `${box.right - 9}px`,
        top: `${top}px`,
        height: `${height}px`,
        transition: 'opacity 0.3s',
        opacity: '1',
      });
      clearTimeout(hideIndicator);
      hideIndicator = setTimeout(() => {
        indicator.style.opacity = '0';
      }, 800);
    },
    { capture: true, passive: true },
  );

  // The viewer's download and forward buttons sit at the photo's top right
  // corner, which moves with each photo, so keep its close button beside
  // them, styled like them: Facebook's close button is the light one made for
  // its white top bar.
  const setStyle = (el, prop, value) => {
    if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value, 'important');
  };
  function placeViewerClose() {
    const area = (el) => el.getBoundingClientRect().width * el.getBoundingClientRect().height;
    const dialog = [...document.querySelectorAll('[role="dialog"]')].sort((a, b) => area(b) - area(a))[0];
    const closeBox = dialog?.querySelector(':scope > div:has(> a[href="/"])');
    const close = closeBox?.querySelector('[role="button"]');
    if (!close) return;
    // Small buttons near the top, not the tall previous/next ones or the thumbnails.
    const neighbour = [...dialog.querySelectorAll('a[role="link"], [role="button"]')]
      .filter((el) => !closeBox.contains(el))
      .map((el) => [el, el.getBoundingClientRect()])
      .filter(([, box]) => box.width > 0 && box.height <= 48 && box.top < 120)
      .sort((a, b) => b[1].right - a[1].right)[0];
    if (!neighbour) return;
    const [like, box] = neighbour;

    const looks = getComputedStyle(like);
    for (const prop of ['width', 'height', 'background-color', 'color', 'opacity']) setStyle(close, prop, looks.getPropertyValue(prop));

    setStyle(closeBox, 'left', `${Math.round(box.right + 8)}px`);
    setStyle(closeBox, 'right', 'auto');
    setStyle(closeBox, 'top', `${Math.round(box.top)}px`);
  }

  // Zooming the photo in the viewer, as in Preview: pinch on the trackpad
  // (Ctrl + scroll too), double-click to zoom in or back out, and scroll or
  // drag to move around the zoomed photo. Facebook's viewer has no zoom.
  // WebKit hands a pinch to the page as gesture events (the page itself
  // doesn't magnify); Chromium-based webviews send it as Ctrl + wheel.
  const ZOOM_MAX = 8;
  const ZOOM_DOUBLE_CLICK = 2.5;
  let zoom = null;
  // Dragging the zoomed photo; a drag isn't a click on whatever is under it.
  let drag = null;
  let dragged = false;
  // The photo: the largest image in the viewer (the blurred backdrop behind it
  // is a small thumbnail, and the thumbnails at the bottom are small).
  const viewerPhoto = () => {
    const pixels = (img) => img.naturalWidth * img.naturalHeight;
    return (
      [...document.querySelectorAll('[role="dialog"] img')]
        .filter((img) => img.getBoundingClientRect().width > 100)
        .sort((a, b) => pixels(b) - pixels(a))[0] ?? null
    );
  };
  const isOn = (el, x, y) => {
    const box = el.getBoundingClientRect();
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  };
  function resetZoom(animate) {
    if (!zoom) return;
    Object.assign(zoom.img.style, { transition: animate ? 'transform 0.2s' : '', transform: '', cursor: '' });
    zoom = null;
  }
  // Another photo (the viewer's URL names it) or a closed viewer starts unzoomed.
  function dropStaleZoom() {
    if (zoom && (!zoom.img.isConnected || zoom.page !== location.href)) resetZoom();
  }
  const startZoom = () => {
    if (zoom) return zoom;
    const img = viewerPhoto();
    if (!img) return null;
    // The zoomed photo may fill what shows of the viewer, not just its own
    // box: the window, cut down by whatever clips the photo (Facebook's own
    // clipping box is wider than the window).
    const stage = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let el = img.parentElement; el; el = el.parentElement) {
      if (getComputedStyle(el).overflow === 'visible') continue;
      const box = el.getBoundingClientRect();
      Object.assign(stage, {
        left: Math.max(stage.left, box.left),
        top: Math.max(stage.top, box.top),
        right: Math.min(stage.right, box.right),
        bottom: Math.min(stage.bottom, box.bottom),
      });
    }
    img.style.transformOrigin = '0 0';
    zoom = { img, page: location.href, base: img.getBoundingClientRect(), stage, scale: 1, x: 0, y: 0 };
    return zoom;
  };
  // A photo smaller than the stage stays inside it; a larger one covers it.
  const clampOffset = (offset, start, size, stageStart, stageEnd) => {
    const a = stageStart - start;
    const b = stageEnd - size - start;
    return Math.min(Math.max(offset, Math.min(a, b)), Math.max(a, b));
  };
  const applyZoom = (scale, x, y, animate) => {
    zoom.scale = Math.min(Math.max(scale, 1), ZOOM_MAX);
    if (zoom.scale === 1) return resetZoom(animate);
    const { base, stage } = zoom;
    zoom.x = clampOffset(x, base.left, base.width * zoom.scale, stage.left, stage.right);
    zoom.y = clampOffset(y, base.top, base.height * zoom.scale, stage.top, stage.bottom);
    Object.assign(zoom.img.style, {
      transition: animate ? 'transform 0.2s' : '',
      transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
      cursor: drag ? 'grabbing' : 'grab',
    });
  };
  // Zooms to scale keeping the point of the photo under (x, y) where it is.
  const zoomAt = (scale, x, y, animate) => {
    const pointX = (x - zoom.base.left - zoom.x) / zoom.scale;
    const pointY = (y - zoom.base.top - zoom.y) / zoom.scale;
    const next = Math.min(Math.max(scale, 1), ZOOM_MAX);
    applyZoom(next, x - zoom.base.left - next * pointX, y - zoom.base.top - next * pointY, animate);
  };

  let pinchFrom = 1;
  document.addEventListener(
    'gesturestart',
    (event) => {
      if (!viewerOpen || !startZoom()) return;
      event.preventDefault();
      pinchFrom = zoom.scale;
    },
    true,
  );
  document.addEventListener(
    'gesturechange',
    (event) => {
      // Pinching back to fit ends the zoom; pinching out again starts anew.
      if (!viewerOpen || !startZoom()) return;
      event.preventDefault();
      zoomAt(pinchFrom * event.scale, event.clientX, event.clientY);
    },
    true,
  );
  document.addEventListener('gestureend', (event) => viewerOpen && zoom && event.preventDefault(), true);
  window.addEventListener(
    'wheel',
    (event) => {
      if (!viewerOpen) return;
      if (event.ctrlKey) {
        if (!startZoom()) return;
        event.preventDefault();
        zoomAt(zoom.scale * Math.exp(-event.deltaY / 100), event.clientX, event.clientY);
      } else if (zoom) {
        event.preventDefault();
        applyZoom(zoom.scale, zoom.x - event.deltaX, zoom.y - event.deltaY);
      } else {
        return;
      }
      event.stopPropagation();
    },
    { capture: true, passive: false },
  );
  document.addEventListener(
    'dblclick',
    (event) => {
      const photo = viewerOpen && viewerPhoto();
      if (!photo || !isOn(photo, event.clientX, event.clientY)) return;
      event.preventDefault();
      if (zoom) return resetZoom(true);
      startZoom();
      zoomAt(ZOOM_DOUBLE_CLICK, event.clientX, event.clientY, true);
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!zoom || event.button !== 0 || !isOn(zoom.img, event.clientX, event.clientY)) return;
      if (!event.target.contains(zoom.img)) return;
      event.preventDefault();
      drag = { x: event.clientX - zoom.x, y: event.clientY - zoom.y, fromX: event.clientX, fromY: event.clientY };
      dragged = false;
      zoom.img.style.cursor = 'grabbing';
    },
    true,
  );
  document.addEventListener(
    'pointermove',
    (event) => {
      if (!drag || !zoom) return;
      dragged ||= Math.hypot(event.clientX - drag.fromX, event.clientY - drag.fromY) > 3;
      applyZoom(zoom.scale, event.clientX - drag.x, event.clientY - drag.y);
    },
    true,
  );
  document.addEventListener(
    'pointerup',
    () => {
      if (!drag) return;
      drag = null;
      if (zoom) zoom.img.style.cursor = 'grab';
      // The click, if any, comes before this runs.
      setTimeout(() => (dragged = false));
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!dragged) return;
      dragged = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  document.addEventListener('dragstart', (event) => zoom && event.preventDefault(), true);
  window.addEventListener('resize', () => resetZoom());

  // Keyboard shortcuts in the spirit of the old desktop app (it showed
  // "Search (⌘K)"). Selectors avoid aria-labels, which Facebook translates.
  const isMac = /Mac/.test(navigator.platform);
  const isVisible = (el) => el && el.getBoundingClientRect().width > 0;
  const chatLinks = () =>
    [...document.querySelectorAll('[role="grid"] [role="row"] a[href*="/messages/"]')].filter(isVisible);
  const shortcuts = {
    search() {
      const input = [...document.querySelectorAll('input[type="search"]')].find(isVisible);
      input?.focus();
      input?.select();
    },
    newMessage() {
      document.querySelector('a[href="/messages/new/"]')?.click();
    },
    openChat(index) {
      chatLinks()[index]?.click();
    },
    moveChat(step) {
      const links = chatLinks();
      const current = links.findIndex((link) => new URL(link.href).pathname === location.pathname);
      links[Math.max(0, Math.min(links.length - 1, current + step))]?.click();
    },
  };
  // Also called from fMess's menu bar on macOS.
  window.__fmessShortcut = (name, arg) => onChatsPage() && shortcuts[name]?.(arg);
  window.addEventListener(
    'keydown',
    (event) => {
      const primary = isMac ? event.metaKey : event.ctrlKey;
      let action = null;
      if (primary && !event.shiftKey && !event.altKey && event.code === 'KeyK') action = ['search'];
      else if (primary && !event.shiftKey && !event.altKey && event.code === 'KeyN') action = ['newMessage'];
      else if (primary && !event.shiftKey && !event.altKey && /^Digit[1-9]$/.test(event.code))
        action = ['openChat', Number(event.code.slice(5)) - 1];
      else if (primary && event.shiftKey && event.code === 'BracketRight') action = ['moveChat', 1];
      else if (primary && event.shiftKey && event.code === 'BracketLeft') action = ['moveChat', -1];
      else if (event.ctrlKey && event.code === 'Tab') action = ['moveChat', event.shiftKey ? -1 : 1];
      if (!action || !onChatsPage()) return;
      event.preventDefault();
      event.stopPropagation();
      shortcuts[action[0]](action[1]);
    },
    true,
  );

  const shown = new Map();
  let nextId = Math.floor(Math.random() * 1e9);
  // When the page last raised a notification itself (see notifyNewestChat).
  let lastPageNotification = 0;
  let raisingFallback = false;
  // Messenger may raise the same message twice; browsers show one notification
  // per tag (Messenger uses the message id), so fMess does too.
  const shownTags = new Set();

  const invoke = (command, args) =>
    window.__TAURI_INTERNALS__
      ? window.__TAURI_INTERNALS__.invoke(command, args)
      : Promise.reject(new Error('fMess bridge unavailable'));

  // Sender and chat of a message notification, by message id (Messenger's
  // tag), read as MWDesktopNotifications does (see MODULE_PATCHES).
  const messageDetails = new Map();
  // A message sent over LATE_MS ago, or in a chat read past it (on another
  // device, say), needs no notification.
  async function isOldNews(db, message) {
    const sent = int64(message?.timestampMs);
    if (sent && serverNow() - Number(sent) > LATE_MS) return true;
    const ReQL = window.require('ReQL');
    const chat = await ReQL.firstAsync(ReQL.fromTableAscending(db.tables.threads).getKeyRange(message.threadKey));
    return Boolean(chat && sent) && int64(chat.lastReadWatermarkTimestampMs) >= sent;
  }
  async function readMessageDetails(db, message) {
    const ReQL = window.require('ReQL');
    const first = (table, ...key) => ReQL.firstAsync(ReQL.fromTableAscending(table).getKeyRange(...key));
    const [thread, contact, participant] = await Promise.all([
      first(db.tables.threads, message.threadKey),
      first(db.tables.contacts, message.senderId),
      first(db.tables.participants, message.threadKey, message.senderId),
    ]);
    if (!thread || !contact) return null;
    const picture = (name, row) => {
      try {
        return moduleFunction(window.require(name))(row) ?? null;
      } catch {
        return null;
      }
    };
    const isGroup = window.require('LSMessagingThreadTypeUtil').isGroup(thread.threadType);
    return {
      thread: String(int64(message.threadKey)),
      sender: participant?.nickname || contact.name || '',
      senderPicture:
        picture('getLSMediaContactProfilePictureLargeUrl', contact) ?? picture('getLSMediaContactProfilePictureUrl', contact),
      group: isGroup ? { name: thread.threadName || null, picture: picture('getLSMediaThreadPictureUrl', thread) } : null,
    };
  }
  // A picture for a native notification, as base64; none rather than a late
  // notification when it is slow or large.
  const pictureData = async (url) => {
    if (!url || typeof url !== 'string') return null;
    try {
      const response = await fetch(url);
      const blob = response.ok ? await response.blob() : null;
      if (!blob || blob.size > 4_000_000) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    } catch {
      return null;
    }
  };
  const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
  const sendNotification = async (notification) => {
    const details = await within(messageDetails.get(String(notification.tag)) ?? Promise.resolve(null), 2000);
    const [icon, image, senderPicture, groupPicture] = await within(
      Promise.all([
        details ? null : pictureData(notification.icon),
        pictureData(notification.image),
        details && pictureData(details.senderPicture),
        details?.group && pictureData(details.group.picture),
      ]),
      3000,
    ) ?? [];
    const message = details && {
      thread: details.thread,
      sender: details.sender,
      senderPicture: senderPicture ?? null,
      group: details.group && { name: details.group.name, picture: groupPicture ?? null },
    };
    return invoke('notify', {
      id: notification.fmessId,
      title: notification.title,
      body: notification.body,
      icon: icon ?? null,
      image: image ?? null,
      message: message || null,
    });
  };

  class FMessNotification extends EventTarget {
    static get permission() {
      return 'granted';
    }

    static requestPermission(callback) {
      callback?.('granted');
      return Promise.resolve('granted');
    }

    constructor(title, options = {}) {
      super();
      this.title = String(title ?? '');
      this.body = String(options.body ?? '');
      this.tag = options.tag ?? '';
      this.icon = options.icon ?? '';
      this.image = options.image ?? '';
      this.data = options.data ?? null;
      this.silent = Boolean(options.silent);
      this.onclick = this.onshow = this.onclose = this.onerror = null;
      if (!raisingFallback) lastPageNotification = Date.now();
      if (this.tag) {
        if (shownTags.has(this.tag)) return;
        shownTags.add(this.tag);
        if (shownTags.size > 500) shownTags.delete(shownTags.values().next().value);
      }
      // The native side takes an i32 id.
      this.fmessId = nextId++ % 0x7fffffff;
      shown.set(this.fmessId, this);
      if (shown.size > 100) shown.delete(shown.keys().next().value);
      sendNotification(this).then(
        () => this.fmessFire('show'),
        () => this.fmessFire('error'),
      );
    }

    close() {
      if (shown.delete(this.fmessId)) this.fmessFire('close');
    }

    fmessFire(type) {
      const event = new Event(type);
      this[`on${type}`]?.call(this, event);
      this.dispatchEvent(event);
    }
  }

  window.Notification = FMessNotification;

  // Some code paths notify through a service worker registration instead.
  if (window.ServiceWorkerRegistration) {
    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      new FMessNotification(title, options);
      return Promise.resolve();
    };
  }

  // Keep navigator.permissions in agreement with Notification.permission.
  const query = navigator.permissions?.query?.bind(navigator.permissions);
  if (query) {
    navigator.permissions.query = (descriptor) =>
      descriptor?.name === 'notifications'
        ? Promise.resolve({
            name: 'notifications',
            state: 'granted',
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
          })
        : query(descriptor);
  }

  // facebook.com only notifies through Web Push, which embedded WebKit lacks,
  // so new messages never reach the shim above. fMess calls this instead when
  // the unread count in the title goes up while the window is in the
  // background, and it notifies about the newest chat in the list.
  // A chat row reads "<name> <preview> · <age>" on screen. It also carries
  // text only screen readers get, clipped to 1px: "Active now" before the name,
  // and "Unread message:" after it when the chat is unread. Emoji are images.
  const rowTexts = (row) => {
    const texts = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const isEmoji = node instanceof HTMLImageElement && node.alt && node.getBoundingClientRect().width <= 24;
      if (node.nodeType !== Node.TEXT_NODE && !isEmoji) continue;
      const text = isEmoji ? node.alt : node.textContent.trim();
      const box = (isEmoji ? node : node.parentElement)?.getBoundingClientRect();
      if (text && box) texts.push({ text, visible: box.width > 1 && box.height > 1 });
    }
    return texts;
  };
  const isUnreadChat = (row) => {
    const texts = rowTexts(row);
    const name = texts.findIndex((part) => part.visible);
    return name >= 0 && texts.slice(name + 1).some((part) => !part.visible);
  };
  const chatSummary = (row) => {
    const texts = rowTexts(row).filter((part) => part.visible).map((part) => part.text);
    const age = texts.lastIndexOf('·');
    const preview = (age > 0 ? texts.slice(1, age) : texts.slice(1)).join(' ').replace(/\s+/g, ' ');
    return { name: texts[0] ?? '', preview };
  };

  // Whether a chat row has nothing to notify about, as Messenger's copy of
  // the chat list says: its newest message is your own, or came in late.
  const nothingNew = async (row) => {
    const thread = row.getAttribute('href')?.match(/\/t\/(\d+)/)?.[1];
    const me = currentUserId();
    if (!thread || !me) return false;
    await loadModules(['ReQL', 'LSDatabaseSingleton']);
    const ReQL = window.require('ReQL');
    const db = await window.require('LSDatabaseSingleton').LSDatabaseSingleton;
    const chat = await ReQL.firstAsync(ReQL.fromTableAscending(db.tables.threads).getKeyRange(int64Key(thread)));
    if (!chat) return false;
    return int64(chat.snippetSenderContactId) === BigInt(me) || serverNow() - Number(int64(chat.lastActivityTimestampMs)) > LATE_MS;
  };

  // Facebook raises its own notifications (see MODULE_PATCHES). In case it
  // stops doing so, notify about the newest unread chat when the count rises
  // and Facebook stayed quiet.
  const notifyNewestChat = async () => {
    const links = chatLinks();
    const unread = links.filter(isUnreadChat);
    // A message you send from your phone in an encrypted chat can leave that
    // chat unread here, and a computer back from sleep catches up on chats
    // all at once; Messenger notifies about neither.
    let link;
    for (const row of unread.length ? unread : links.slice(0, 1)) {
      if (!(await nothingNew(row).catch(() => false))) {
        link = row;
        break;
      }
    }
    // Messenger itself stays quiet during Do Not Disturb.
    if (!link || isMuted() || Date.now() - lastPageNotification < 4000) return;
    const chat = chatSummary(link);
    const href = link.getAttribute('href');
    raisingFallback = true;
    try {
      const notification = new FMessNotification(chat.name || 'Messenger', {
        body: chat.preview || 'New message',
        icon: link.querySelector('img')?.currentSrc,
      });
      notification.onclick = () => chatLinks().find((row) => row.getAttribute('href') === href)?.click();
    } finally {
      raisingFallback = false;
    }
  };

  // The Dock badge counts unread chats in the list; the page title counts
  // Facebook's own notifications instead.
  let lastUnread = -1;
  setInterval(() => {
    if (!onChatsPage()) return;
    const count = chatLinks().filter(isUnreadChat).length;
    if (count === lastUnread) return;
    // The list fills in while the page loads; that isn't new mail.
    const rose = lastUnread >= 0 && count > lastUnread && performance.now() > 10000;
    lastUnread = count;
    // A theme can show it (attr(data-fmess-unread)).
    if (count) document.documentElement.setAttribute('data-fmess-unread', count);
    else document.documentElement.removeAttribute('data-fmess-unread');
    invoke('set_unread_count', { count }).catch(() => {});
    if (rose && !document.hasFocus()) setTimeout(notifyNewestChat, 1500);
  }, 2000);

  // A theme can draw buttons on the chat list (the Zalo look's bar down its
  // left side) and list them in --fmess-buttons on the list: "name left top
  // size" each, comma-separated, a negative top counting from the bottom.
  // fMess lights the one under the pointer (--fmess-hover-left/-top on the
  // list) and runs those it knows: "account" opens the account menu, as the
  // account button does, and "settings" opens fMess's Settings.
  const themeButtonAt = (list, x, y) => {
    const box = list.getBoundingClientRect();
    for (const spec of getComputedStyle(list).getPropertyValue('--fmess-buttons').split(',')) {
      const [name, left, top, size] = spec.trim().replace(/"/g, '').split(/\s+/);
      if (!name || !(Number(size) > 0)) continue;
      const button = { name, left: box.left + Number(left), size: Number(size) };
      button.top = Number(top) < 0 ? box.bottom + Number(top) - button.size : box.top + Number(top);
      if (x >= button.left && x <= button.left + button.size && y >= button.top && y <= button.top + button.size) return button;
    }
    return null;
  };
  let hoveredList = null;
  document.addEventListener(
    'mousemove',
    (event) => {
      const list = event.target instanceof Element && event.target.closest('[role="navigation"]');
      const unlight = (el) => (el.style.removeProperty('--fmess-hover-top'), el.style.removeProperty('cursor'));
      if (hoveredList && hoveredList !== list) unlight(hoveredList);
      hoveredList = list || null;
      if (!list) return;
      const button = themeButtonAt(list, event.clientX, event.clientY);
      if (!button) return unlight(list);
      const box = list.getBoundingClientRect();
      list.style.setProperty('--fmess-hover-left', `${button.left - box.left}px`);
      list.style.setProperty('--fmess-hover-top', `${button.top - box.top}px`);
      list.style.cursor = 'pointer';
    },
    { passive: true },
  );
  document.addEventListener(
    'click',
    (event) => {
      const list = event.target instanceof Element && event.target.closest('[role="navigation"]');
      const button = list && themeButtonAt(list, event.clientX, event.clientY);
      if (!button || !['account', 'settings'].includes(button.name)) return;
      event.preventDefault();
      event.stopPropagation();
      if (button.name === 'settings') invoke('open_settings').catch(() => {});
      else invoke('show_account_menu', { name: currentAccount()?.name ?? '', x: button.left + button.size + 6, y: button.top }).catch(() => {});
    },
    true,
  );

  // Called from Rust when the user clicks a native notification.
  window.__fmessNotificationClicked = (id, thread) => {
    const notification = shown.get(id);
    window.focus();
    if (notification) notification.fmessFire('click');
    else if (thread) chatLinks().find((row) => new RegExp(`/t/${thread}/?$`).test(row.getAttribute('href')))?.click();
  };

  // Replying from a notification, as in the old app. Messenger sends what is
  // typed in a chat's message box (encrypted chats too), so fMess opens the
  // chat, types the reply there and sends it, then goes back to the chat
  // that was open. The window stays as it was.
  const waitFor = async (check, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) {
      const value = check();
      if (value) return value;
    }
    return null;
  };
  const openChat = (id, thread) => {
    // Messenger's own handler for the notification knows the chat's kind.
    const notification = shown.get(id);
    if (notification) return notification.fmessFire('click');
    const row = chatLinks().find((link) => new RegExp(`/t/${thread}/?$`).test(link.getAttribute('href')));
    if (row) return row.click();
    history.pushState(null, '', `/messages/t/${thread}/`);
    dispatchEvent(new PopStateEvent('popstate'));
  };
  window.__fmessReply = async (id, thread, text) => {
    const inChat = () => new RegExp(`^/messages/(?:e2ee/)?t/${thread}/?$`).test(location.pathname);
    const before = location.pathname;
    const opening = !inChat();
    const oldBox = composer();
    if (opening) openChat(id, thread);
    // Until the chat opens, the previous chat's box is still there.
    const box =
      (await waitFor(() => inChat() && (!opening || composer() !== oldBox) && composer(), 10000)) ?? (inChat() && composer());
    let sent = false;
    if (box) {
      box.focus();
      // A draft in the chat waits while the reply goes out, then comes back.
      const draft = box.textContent.trim() ? box.textContent : '';
      if (draft) {
        document.execCommand('selectAll');
        document.execCommand('delete');
        await waitFor(() => !composer()?.textContent.trim(), 1000);
      }
      document.execCommand('insertText', false, text);
      // The editor shows what was typed a moment later.
      if (await waitFor(() => composer()?.textContent.trim(), 1000)) {
        (composer() ?? box).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
        );
        sent = Boolean(await waitFor(() => !composer()?.textContent.trim(), 3000));
      }
      if (draft) {
        // An unsent reply stays in the notice below instead.
        if (!sent) {
          document.execCommand('selectAll');
          document.execCommand('delete');
        }
        composer()?.focus();
        document.execCommand('insertText', false, draft);
      }
    }
    if (!sent) {
      // Say so, and keep the reply: clicking opens the chat.
      const notice = new FMessNotification('Reply not sent', { body: text });
      notice.onclick = () => openChat(id, thread);
      return false;
    }
    if (location.pathname !== before && /^\/messages\/(e2ee\/)?t\//.test(before)) history.back();
    return true;
  };

  // As in the old app, reading a chat clears its notifications: opening it
  // in fMess, or coming back to fMess while it is open.
  const clearOpenChatNotifications = () => {
    const thread = location.pathname.match(/^\/messages\/(?:e2ee\/)?t\/(\d+)/)?.[1];
    if (thread && document.hasFocus()) invoke('clear_notifications', { thread }).catch(() => {});
  };
  window.addEventListener('focus', clearOpenChatNotifications);

  // The old desktop app showed whose account it was on: a profile picture
  // above the chats, opening a menu with Log Out. Facebook keeps both in its
  // top bar, which fMess hides in the chats, so the picture goes before
  // "Chats" and opens fMess's native account menu (show_account_menu).
  const ACCOUNT = 'fmess-account';
  const accountStyle = document.createElement('style');
  accountStyle.textContent = `
    #${ACCOUNT} {
      flex: none;
      width: 32px;
      height: 32px;
      /* As tall as the header row, which is shorter than "Chats" itself. */
      margin: -8px 12px -8px 0;
      border-radius: 50%;
      background: var(--secondary-button-background, #e4e6eb) center / cover no-repeat;
      color: var(--primary-text, #050505);
      font: 600 15px/32px system-ui, -apple-system, sans-serif;
      text-align: center;
      cursor: pointer;
    }
    #${ACCOUNT}:hover { filter: brightness(0.9); }
  `;
  withRoot((root) => root.append(accountStyle));

  // The picture comes from Messenger's own contact entry for you. Facebook's
  // hidden top bar has it too, but also every profile of its account menu.
  let contactPicture = null;
  const readContactPicture = async () => {
    const me = currentUserId();
    if (!me) return;
    await loadModules(['LSDatabaseSingleton']);
    const db = await window.require('LSDatabaseSingleton').LSDatabaseSingleton;
    contactPicture = (await db.tables.contacts.get(int64Key(me)))?.profilePictureUrl || contactPicture;
    // A theme can show your picture and name (var(--fmess-avatar), attr(data-fmess-name)).
    const root = document.documentElement;
    if (contactPicture) root.style.setProperty('--fmess-avatar', `url("${contactPicture}")`);
    root.setAttribute('data-fmess-name', window.require('CurrentUserInitialData').NAME || '');
  };
  const currentAccount = () => {
    try {
      const user = window.require('CurrentUserInitialData');
      const barPicture = [...document.querySelectorAll('[role="banner"] svg image')].find((image) => !image.closest('[role="dialog"]'));
      return {
        name: user.NAME,
        initial: [...(user.SHORT_NAME || user.NAME || '?')][0],
        picture: contactPicture || barPicture?.getAttribute('xlink:href') || barPicture?.getAttribute('href') || '',
      };
    } catch {
      return null;
    }
  };
  if (!window.opener) {
    window.addEventListener('load', () => setTimeout(() => readContactPicture().catch(() => {}), 2000));
    // Picture links expire; Messenger refreshes the entry.
    setInterval(() => readContactPicture().catch(() => {}), 10 * 60 * 1000);
  }

  let account = null;
  function openAccountMenu() {
    const box = document.getElementById(ACCOUNT).getBoundingClientRect();
    invoke('show_account_menu', { name: account.name, x: box.left, y: box.bottom + 4 }).catch(() => {});
  }

  // Facebook redraws the chat list header now and then, so check each second.
  setInterval(() => {
    if (window.opener || !onChatsPage()) return;
    account = currentAccount() || account;
    // The header row holds "Chats" and the new message button.
    let header = document.querySelector('a[href="/messages/new/"]');
    while (header && !header.querySelector('h1')) header = header.parentElement;
    if (!header || !account) return;
    let button = document.getElementById(ACCOUNT);
    if (!button) {
      button = document.createElement('div');
      button.id = ACCOUNT;
      button.setAttribute('role', 'button');
      button.tabIndex = 0;
      button.addEventListener('click', openAccountMenu);
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openAccountMenu();
      });
    }
    if (header.firstElementChild !== button) header.prepend(button);
    if (button.title !== account.name) {
      button.title = account.name;
      button.setAttribute('aria-label', account.name);
    }
    if (button.dataset.picture !== account.picture) {
      button.dataset.picture = account.picture;
      button.style.backgroundImage = account.picture ? `url("${account.picture}")` : '';
      button.textContent = account.picture ? '' : account.initial;
    }
  }, 1000);

  // Called from the account menu. Facebook's own Log Out item posts this
  // form, which carries the logout token, and Facebook signs out from there.
  window.__fmessLogOut = () => {
    const form = document.querySelector('form[action^="/logout.php"]');
    if (!form) return false;
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
    return true;
  };

  // The theme picked in Settings: CSS fMess has checked (see themes.rs), kept
  // last in the page so it wins over Facebook's. A light theme ("mode: light")
  // also gets Facebook's light colours in dark mode, copied from Facebook's
  // own stylesheets.
  const THEME = 'fmess-theme';
  let theme = null;
  const lightColours = () => {
    let colours = '';
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules ?? []) {
        if (!/__fb-light-mode/.test(rule.selectorText || '') || !(rule.style?.length > 100)) continue;
        for (const name of rule.style) if (name.startsWith('--')) colours += `${name}: ${rule.style.getPropertyValue(name)} !important;`;
      }
    }
    return colours ? `.__fb-dark-mode { ${colours} color-scheme: light; }\n` : '';
  };
  const applyTheme = (next) => {
    theme = next?.css ? next : null;
    withRoot((root) => {
      let style = document.getElementById(THEME);
      if (!theme) return style?.remove();
      if (!style) {
        style = document.createElement('style');
        style.id = THEME;
      }
      style.textContent = (theme.light ? lightColours() : '') + theme.css;
      root.append(style);
    });
  };
  applyTheme(settings.theme);
  // Facebook's stylesheets (and their light colours) arrive with the page.
  window.addEventListener('load', () => theme && applyTheme(theme));

  // Called by fMess after every page load and when its settings change.
  window.__fmessApplySettings = (next) => {
    privacy.blockTyping = Boolean(next.blockTyping);
    if (next.theme?.css !== theme?.css || Boolean(next.theme?.light) !== Boolean(theme?.light)) applyTheme(next.theme);
  };
})();
