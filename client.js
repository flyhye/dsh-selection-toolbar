/**
 * Floating text-selection toolbar for the Harness Web UI.
 *
 * The user selects text in the transcript and a small toolbar appears beside
 * the selection with two actions: quote it into the current Session's composer
 * as a numbered reference chip, or fork the Session into a side conversation
 * in the right Sidebar.
 *
 * The quote path follows the reference-source contract rather than writing the
 * selection into the draft: the composer stores an atomic chip labeled `#N 摘要`,
 * the draft spells it `#N`, and submit-time serialization expands the chip to
 * `[#N] (第 T 轮) passage`, so the composer stays short while the model still
 * reads the quoted text and knows which turn it came from.
 *
 * The side conversation forks the Session (cut at the quoted turn when it can
 * be pinned) and reveals a resource tab in the right Sidebar whose body renders
 * that forked Session's own Conversation.
 *
 * Rendering: `shell.overlay` is a frame-wide, click-through layer, so the
 * toolbar positions itself against the viewport (`position: fixed`) and never
 * blocks the application underneath. The selected text is captured when the
 * toolbar appears, so pressing a button still works after the browser drops
 * the selection.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-selection-toolbar',
  factory(require) {
    const React = require('react');

    const NS = 'selection-toolbar';
    const SLOT = 'shell.overlay';
    const ENTRY_ID = 'selection-toolbar';
    /** Reference source name; the chip's serializer routes by this key. */
    const SOURCE_NAME = 'selection-quote';
    const GAP = 8;
    const EDGE = 8;
    /**
     * Separator between the quote number and its passage inside a reference id.
     * The id round-trips through the persisted draft, so the serializer can
     * recover the passage without any live lookup table.
     */
    const REF_SEP = '\u0000';
    /** Prefix of the per-Session quote counter in browser storage. */
    const COUNTER_KEY = 'dsh-selection-toolbar.counter';
    /** Prefix of the per-Session passage-to-number map in browser storage. */
    const MAP_KEY = 'dsh-selection-toolbar.map';
    /** Maximum mapped passages per Session; older entries are dropped first. */
    const MAP_LIMIT = 500;
    /** Longest inline chip label before the host's own ellipsis takes over. */
    const LABEL_MAX = 40;
    /**
     * Longest passage carried inside a reference id. The id is persisted with
     * the draft, so an unbounded passage would bloat — or be silently truncated
     * by — that store. Truncating here instead keeps the cut visible: the model
     * reads the note, and the reader is told which quote was shortened.
     */
    const PASSAGE_MAX = 1500;

    /**
     * Right-Sidebar plumbing for the side conversation.
     * The address names a forked Session, so reopening the same address reveals
     * the same tab rather than forking again: the host dedupes resource tabs by
     * address, which is why the fork's own id is what the address carries.
     */
    const SIDE_PROTOCOL = 'selectionchat';
    const SIDE_ADDRESS = `dsh-resource://${SIDE_PROTOCOL}/session/`;
    const SIDE_KIND = 'selectionchat';
    /** Registration identity: unique across every tab type, and the slot key. */
    const SIDE_TAB_ID = '@local/dsh-selection-toolbar#side';
    /**
     * The body's own conversation seat. Seat names are per-body declarations —
     * the shipped subagent body already declares `sidebar.chat.conversation`,
     * and the core allows only one declarer per seat, so this body declares and
     * occupies its own namespaced seat instead of sharing theirs.
     */
    const SIDE_SEAT = 'selection-toolbar.side-chat.conversation';
    /**
     * How long opening a side conversation may stay silent.
     * The fork crosses the Host, so it is not instant, but a step that never
     * settles would otherwise leave the notice up with no recourse — after this
     * the reader gets a visible failure instead of an endless "opening…".
     */
    const SIDE_TIMEOUT_MS = 15000;
    /** Attempts to place the side-conversation tab into the column's surface. */
    const OPEN_ATTEMPTS = 8;
    /** Delay between place attempts while the column adopts its surface. */
    const OPEN_RETRY_MS = 120;

    const DICT = {
      zh: {
        label: '选中文本操作',
        addToChat: '添加到对话',
        blocked: '输入框正在提交，暂时不能引用',
        failed: '引用失败，请重试',
        truncated: '引用过长，已保留前 {max} 字（原 {total} 字）',
        turn: '第 {turn} 轮',
        sideChat: '侧边讨论',
        sideChatFailed: '侧边对话打开失败，请重试',
        sideChatNothingToFork: '这个会话还没有已完成的回合，暂无可分叉的内容——等本轮回复结束后再试',
        sideChatTitle: '侧边讨论',
      },
      en: {
        label: 'Selection actions',
        addToChat: 'Quote',
        blocked: 'The composer is busy; try again in a moment',
        failed: 'Could not quote that; try again',
        truncated: 'Quote shortened to {max} characters (was {total})',
        turn: 'turn {turn}',
        sideChat: 'Discuss',
        sideChatFailed: 'Could not open the side conversation; try again',
        sideChatNothingToFork: 'This session has no completed turn yet, so there is nothing to fork — try again once the current reply finishes',
        sideChatTitle: 'Side conversation',
      },
    };

    /** Elements whose text is a draft being edited rather than readable content. */
    const NON_CONTENT = '[data-conversation-region="composer"], [contenteditable], textarea, input, [data-composer-card]';

    const STYLE = `
.dshSt_root{position:fixed;z-index:1;display:flex;align-items:center;gap:2px;padding:3px;
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-overlay);
  box-shadow:var(--dsw-elevation-soft);border:1px solid var(--dsw-alias-border-l1);
  font-family:var(--dsw-font-family);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);
  user-select:none;-webkit-user-select:none;pointer-events:auto}
.dshSt_btn{display:flex;align-items:center;gap:6px;height:28px;padding:0 9px;border:0;border-radius:var(--dsw-radius-sm);
  background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
.dshSt_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshSt_btn:active{background:var(--dsw-alias-interactive-bg-hover-solid)}
.dshSt_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshSt_icon{flex:none;display:block;opacity:.85}
.dshSt_sideTab{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}
`;

    /** @returns the innermost element for a selection boundary point. */
    function elementOf(node) {
      if (node === null || node === undefined) return null;
      return node.nodeType === 1 ? node : node.parentElement;
    }

    /**
     * Whether a node belongs to readable transcript text rather than a control,
     * an editable draft, or another panel.
     * @param el - boundary element.
     * @returns whether the node is transcript content inside a Session.
     */
    function isTranscript(el) {
      if (el === null || el.closest === undefined) return false;
      if (el.closest(NON_CONTENT) !== null) return false;
      return el.closest('[data-conversation-session]') !== null;
    }

    /** @returns the Session owning the transcript node, or null. */
    function sessionOf(el) {
      const host = el.closest('[data-conversation-session]');
      if (host === null) return null;
      const id = host.getAttribute('data-conversation-session');
      return id === null || id === '' ? null : id;
    }

    /**
     * Read the conversation turn the node belongs to.
     * The host stamps every chat row with `data-chat-turn` (it uses the same
     * attribute to locate a turn while scrolling), so the number is a stable
     * host fact rather than a guess. Not every row carries one — a grouping row
     * or a local echo may not — hence the null.
     * @param el - boundary element.
     * @returns the turn number, or null when the row is not turn-bearing.
     */
    function turnOf(el) {
      if (el === null || el.closest === undefined) return null;
      const row = el.closest('[data-chat-turn]');
      if (row === null) return null;
      const raw = row.getAttribute('data-chat-turn');
      if (raw === null || raw === '') return null;
      const turn = Number(raw);
      return Number.isSafeInteger(turn) && turn >= 0 ? turn : null;
    }

    /**
     * Read the live browser selection when it covers transcript text.
     * @returns the selected text, its owning Session, the anchor rect, and the
     *   originating turn (null when the selection spans turns or has none).
     */
    function readSelection() {
      const selection = window.getSelection();
      if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
      const text = selection.toString().trim();
      if (text === '') return null;
      const anchorEl = elementOf(selection.anchorNode);
      const focusEl = elementOf(selection.focusNode);
      if (!isTranscript(anchorEl) || !isTranscript(focusEl)) return null;
      const sessionId = sessionOf(anchorEl);
      if (sessionId === null) return null;
      // A selection confined to one turn can cite it. One that runs across turns
      // cannot: naming either end would misattribute half the passage, so the
      // provenance is dropped rather than guessed.
      const anchorTurn = turnOf(anchorEl);
      const turn = anchorTurn !== null && anchorTurn === turnOf(focusEl) ? anchorTurn : null;
      const range = selection.getRangeAt(0);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
      const rect = rects.length === 0 ? range.getBoundingClientRect() : rects[rects.length - 1];
      if (rect === undefined || (rect.width === 0 && rect.height === 0)) return null;
      return {
        text,
        sessionId,
        turn,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      };
    }

    /**
     * Place the toolbar above the selection, flipping below when the viewport
     * has no room and staying inside the horizontal edges.
     * @param el - toolbar element.
     * @param rect - selection rectangle in viewport coordinates.
     */
    function place(el, rect) {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let left = rect.left + (rect.right - rect.left) / 2 - width / 2;
      left = Math.min(Math.max(EDGE, left), Math.max(EDGE, viewportWidth - width - EDGE));
      let top = rect.top - height - GAP;
      if (top < EDGE) {
        top = rect.bottom + GAP;
        if (top + height > viewportHeight - EDGE) top = Math.max(EDGE, viewportHeight - height - EDGE);
      }
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    }

    /**
     * Build the chip's visible label from its quote number and a short excerpt,
     * collapsed to one line so the inline chip never wraps the composer.
     * @param number - the Session's quote number.
     * @param text - quoted passage.
     * @returns the inline label, for example `#3 超时设为 30s`.
     */
    function chipLabel(number, text) {
      const line = text.replace(/\s+/gu, ' ').trim();
      return `#${number} ${line.length <= LABEL_MAX ? line : `${line.slice(0, LABEL_MAX - 1)}…`}`;
    }

    /**
     * Encode a quote as one reference id.
     * The id is the only channel that survives into the persisted draft, so it
     * carries the number the reader sees, the turn it came from, and the passage
     * the model needs.
     *
     * Layout: `number \0 turn \0 passage`. The turn field is omitted (its
     * separator kept as an empty segment) when the selection spans turns, so
     * the segment count always speaks for the format and no version marker is
     * needed: two segments is the older `number \0 passage` shape.
     * @param number - the Session's quote number.
     * @param text - quoted passage.
     * @param turn - originating conversation turn, or null when not attributable.
     * @returns the reference id.
     */
    function encodeRef(number, text, turn) {
      return `${number}${REF_SEP}${turn === null ? '' : turn}${REF_SEP}${text}`;
    }

    /**
     * Recover the quote number, turn, and passage from a reference id.
     * Ids written before quoting was numbered carry no separator; those answer
     * an absent number and treat the whole id as the passage.
     * @param ref - the reference id.
     * @returns the quote number, turn, and passage.
     */
    function decodeRef(ref) {
      const first = ref.indexOf(REF_SEP);
      if (first < 0) return { number: null, turn: null, text: ref };
      const number = Number.parseInt(ref.slice(0, first), 10);
      const rest = ref.slice(first + 1);
      const second = rest.indexOf(REF_SEP);
      // A single separator is the older `number \0 passage` layout: everything
      // after it is passage, and the quote simply has no provenance.
      if (second < 0) {
        return { number: Number.isFinite(number) ? number : null, turn: null, text: rest };
      }
      const turn = rest.slice(0, second);
      const parsedTurn = turn === '' ? null : Number.parseInt(turn, 10);
      return {
        number: Number.isFinite(number) ? number : null,
        turn: parsedTurn !== null && Number.isSafeInteger(parsedTurn) && parsedTurn >= 0 ? parsedTurn : null,
        text: rest.slice(second + 1),
      };
    }

    /**
     * Read the next quote number for a Session and remember that it was spent.
     * The counter is per Session and kept beside the draft, so numbering
     * restarts only when the browser loses its storage.
     * @param sessionId - transcript Session identity.
     * @returns the next quote number.
     */
    function nextQuoteNumber(sessionId) {
      const key = `${COUNTER_KEY}.${sessionId}`;
      let current = 0;
      try {
        const stored = window.localStorage.getItem(key);
        const parsed = stored === null ? 0 : Number.parseInt(stored, 10);
        if (Number.isFinite(parsed) && parsed > 0) current = parsed;
      } catch {
        /* storage denied: numbering still advances for this page */
      }
      const next = current + 1;
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        /* keep the in-memory number; a later quote may reuse it */
      }
      return next;
    }

    /**
     * Give back the most recently spent number after a refused insert, so a
     * failed quote does not leave a hole in the numbering.
     * @param sessionId - transcript Session identity.
     * @param number - the number that was allocated and not used.
     */
    function rollbackQuoteNumber(sessionId, number) {
      try {
        const key = `${COUNTER_KEY}.${sessionId}`;
        const stored = window.localStorage.getItem(key);
        const parsed = stored === null ? 0 : Number.parseInt(stored, 10);
        if (parsed === number) window.localStorage.setItem(key, String(number - 1));
      } catch {
        /* a skipped rollback only means the next quote skips one number */
      }
    }

    /** djb2-style hash, enough to tell distinct passages apart in the reuse map. */
    function hashOf(text) {
      let h = 5381;
      for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    }

    /**
     * Read the Session's passage-to-number map.
     * @param sessionId - transcript Session identity.
     * @returns the parsed map, or an empty object when storage is unusable.
     */
    function readQuoteMap(sessionId) {
      try {
        const raw = window.localStorage.getItem(`${MAP_KEY}.${sessionId}`);
        const parsed = raw === null ? {} : JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    /**
     * Persist the Session's passage-to-number map.
     * @param sessionId - transcript Session identity.
     * @param map - the map to store.
     */
    function writeQuoteMap(sessionId, map) {
      try {
        window.localStorage.setItem(`${MAP_KEY}.${sessionId}`, JSON.stringify(map));
      } catch {
        /* dropping the map only loses duplicate detection */
      }
    }

    /**
     * Look up the number an earlier quote of the same passage received.
     * @param sessionId - transcript Session identity.
     * @param text - quoted passage.
     * @returns the existing number, or null when this passage is new.
     */
    function lookupQuoteNumber(sessionId, text) {
      const map = readQuoteMap(sessionId);
      const number = map[hashOf(text)];
      return typeof number === 'number' && Number.isFinite(number) ? number : null;
    }

    /**
     * Record the number a successful quote handed out.
     * @param sessionId - transcript Session identity.
     * @param text - quoted passage.
     * @param number - the quote number the chip displays.
     */
    function rememberQuoteNumber(sessionId, text, number) {
      const map = readQuoteMap(sessionId);
      map[hashOf(text)] = number;
      const keys = Object.keys(map);
      if (keys.length > MAP_LIMIT) delete map[keys[0]];
      writeQuoteMap(sessionId, map);
    }

    /**
     * Fold the composer's clipboard projection back to its detect projection.
     * Every reference chip occupies exactly one detect character while carrying
     * its whole clipboard text, so each occurrence shortens the draft by the
     * difference.
     * @param state - the Session input snapshot.
     * @returns the detect-coordinate length, which is also the append offset.
     */
    function detectEndOf(state) {
      let end = state.draft.length;
      for (const occurrence of state.occurrences) end -= occurrence.length - 1;
      return end < 0 ? 0 : end;
    }

    const IconAdd = () =>
      React.createElement(
        'svg',
        { className: 'dshSt_icon', width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('path', {
          d: 'M2.6 12.6c3.1 0 5.1-1.5 5.6-4.6M8.6 3.2h5.2v5.2',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        React.createElement('path', {
          d: 'M13.4 3.2 7.2 9.4',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
      );

    /**
     * Side-conversation mark: a panel split off to the right of the transcript,
     * which is what the action opens.
     */
    const IconSide = () =>
      React.createElement(
        'svg',
        { className: 'dshSt_icon', width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('rect', {
          x: 2, y: 3, width: 12, height: 10, rx: 2,
          stroke: 'currentColor', strokeWidth: 1.4,
        }),
        React.createElement('path', {
          d: 'M10 3v10',
          stroke: 'currentColor', strokeWidth: 1.4,
        }),
      );

    /**
     * The toolbar itself: tracks the browser selection and offers its actions.
     * @param props - carries the Client context.
     */
    function SelectionToolbar(props) {
      const { ctx } = props;
      const boxRef = React.useRef(null);
      // Text whose toolbar an action consumed; it must not reappear while that same
      // selection is still the live one.
      const consumedRef = React.useRef(null);
      const [selection, setSelection] = React.useState(null);
      const [placed, setPlaced] = React.useState(false);

      const subscribeLocale = React.useCallback((onChange) => ctx.locale.subscribe(onChange), [ctx]);
      const readLocale = React.useCallback(() => ctx.locale.getSnapshot(), [ctx]);
      React.useSyncExternalStore(subscribeLocale, readLocale);
      const t = ctx.locale.bind(NS);

      /** Hide without suppressing the same text again. */
      const hide = React.useCallback(() => setSelection(null), []);
      /**
       * Hide the toolbar and suppress this exact text, so the selection an
       * action just handled does not re-offer its toolbar until the reader
       * selects something else.
       * @param text - the passage the action consumed.
       */
      const consume = React.useCallback((text) => {
        consumedRef.current = text;
        setSelection(null);
      }, []);

      React.useEffect(() => {
        let frame = 0;

        const sync = () => {
          const next = readSelection();
          if (next === null) {
            consumedRef.current = null;
            setSelection(null);
            return;
          }
          // A different selection clears the consumed marker, so the same text can
          // offer its toolbar again once the reader has selected something else.
          if (consumedRef.current !== null && consumedRef.current !== next.text) consumedRef.current = null;
          if (consumedRef.current === next.text) {
            setSelection(null);
            return;
          }
          setSelection((current) => {
            if (current !== null && current.text === next.text && current.sessionId === next.sessionId
              && current.rect.left === next.rect.left && current.rect.top === next.rect.top
              && current.rect.right === next.rect.right && current.rect.bottom === next.rect.bottom) return current;
            return next;
          });
        };

        // A frame delay lets the browser finish the gesture that changed the selection.
        const schedule = () => {
          if (frame !== 0) return;
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            sync();
          });
        };

        const onPointerDown = (event) => {
          const box = boxRef.current;
          if (box !== null && event.target instanceof Node && box.contains(event.target)) return;
          consumedRef.current = null;
          hide();
        };

        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            consumedRef.current = null;
            hide();
          }
        };

        const onSelectionChange = () => schedule();
        const onMouseUp = () => schedule();
        const onKeyUp = () => schedule();
        const onScroll = () => schedule();
        const onResize = () => schedule();

        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('mouseup', onMouseUp, true);
        document.addEventListener('keyup', onKeyUp, true);
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);

        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame);
          document.removeEventListener('selectionchange', onSelectionChange);
          document.removeEventListener('mouseup', onMouseUp, true);
          document.removeEventListener('keyup', onKeyUp, true);
          document.removeEventListener('mousedown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('resize', onResize);
        };
      }, [hide]);

      // Measure the rendered toolbar, then anchor it against the stored rectangle.
      // It stays invisible until placed, so the first frame never flashes at 0,0.
      React.useLayoutEffect(() => {
        const el = boxRef.current;
        if (el === null || selection === null) {
          setPlaced(false);
          return;
        }
        place(el, selection.rect);
        setPlaced(true);
      }, [selection]);

      /**
       * Resolve the composer input of the Session that owns the selection.
       * The facade exists only for a retained Session generation, so a stale
       * transcript node answers null instead of throwing.
       * @param sessionId - transcript Session identity.
       * @returns the per-Session input facade, its scope, and its binding.
       */
      const inputFor = React.useCallback((sessionId) => {
        const actx = ctx.sessions.scope(sessionId);
        if (actx === undefined) return null;
        const conversation = actx.get('conversation');
        if (conversation === undefined) return null;
        const binding = ctx.sessions.binding(sessionId);
        if (binding === undefined) return null;
        return { actx, binding, input: conversation.input, facade: conversation.input.for(actx) };
      }, [ctx]);

      const onAdd = React.useCallback(() => {
        const current = selection;
        if (current === null) return;
        const target = inputFor(current.sessionId);
        if (target === null) {
          consume(current.text);
          return;
        }
        const state = target.facade.state.getSnapshot();
        if (state.phase === 'adjudicating' || state.phase === 'submitting') {
          target.facade.notify('error', t('blocked'));
          consume(current.text);
          return;
        }
        // Append at the draft end: the chip is atomic, so the span is a collapsed
        // caret in detect coordinates guarded by the current draft revision.
        const at = detectEndOf(state);
        // Cut an over-long passage before it reaches the id, and say so. Silent
        // truncation by the draft store would lose text the reader believes was
        // quoted; this way the cut is visible in the chip label, the note, and
        // the text the model receives.
        const tooLong = current.text.length > PASSAGE_MAX;
        const passage = tooLong ? current.text.slice(0, PASSAGE_MAX) : current.text;
        // Keep the note next to the passage so the model knows the quote is
        // partial, and keep it short enough that it cannot itself be truncated.
        const quoted = tooLong ? `${passage}…[+${current.text.length - PASSAGE_MAX}]` : passage;
        // Quoting the same passage again reuses its number instead of burning
        // a fresh one; only a brand-new passage advances the counter.
        const reused = lookupQuoteNumber(current.sessionId, quoted);
        const number = reused === null ? nextQuoteNumber(current.sessionId) : reused;
        // Dispatch from the Session scope: the composer's listener is registered
        // there, and Cordis delivers only events emitted inside that subtree.
        // `bail` reports the editor's answer; `emit` returns void, so it cannot
        // distinguish an applied edit from a refused one.
        const applied = target.actx.bail('slash/input-insert-reference', {
          reference: {
            source: SOURCE_NAME,
            ref: encodeRef(number, quoted, current.turn),
            label: chipLabel(number, quoted),
            // The draft shows the chip, not the passage; `#N` is what a copy of
            // the draft should spell, and it stays one line by construction.
            clipboardText: `#${number}`,
          },
          span: { start: at, end: at, draftRev: state.draftRev },
        });
        if (applied === true) {
          if (reused === null) rememberQuoteNumber(current.sessionId, quoted, number);
          target.facade.focus();
          if (tooLong) {
            target.facade.notify('info', t('truncated', {
              max: String(PASSAGE_MAX),
              total: String(current.text.length),
            }));
          }
        } else {
          // A refused insert gives the number back, so the numbering stays
          // gap-free even after failures.
          if (reused === null) rollbackQuoteNumber(current.sessionId, number);
          target.facade.notify('error', t('failed'));
        }
        consume(current.text);
      }, [selection, inputFor, t, consume]);

      /**
       * Resolve the event seq that closes one turn, which is what `fork` takes.
       * The seq is not the turn number: it is a durable log position, and only
       * the Conversation timeline knows it. A turn with no `end` is still open
       * and cannot be a fork boundary, so it answers undefined.
       * @param sessionId - the Session owning the turn.
       * @param turn - conversation turn number, or null when unknown.
       * @returns the closing seq, or undefined when it cannot be pinned.
       */
      const seqForTurn = React.useCallback((sessionId, turn) => {
        if (turn === null || turn === undefined) return undefined;
        const binding = ctx.sessions.binding(sessionId);
        if (binding === undefined) return undefined;
        const chat = ctx.uiConversation.binding(binding).target('chat');
        const snapshot = chat.getSnapshot();
        const location = snapshot?.timeline?.turns?.get(turn);
        return location?.end?.seq;
      }, [ctx]);

      /**
       * Fork the owning Session and reveal the side conversation beside it.
       *
       * The fork is the whole point: it carries the history up to the quoted
       * turn, so the side chat answers with the same context the main thread
       * had.
       *
       * `atSeq` cuts at the exact turn the reader quoted, which is stricter than
       * the host default (latest completed turn) and keeps the side chat from
       * inheriting turns the reader has not referred to. When the turn cannot be
       * pinned — a cross-turn selection, or a turn whose end is not loaded — the
       * argument is omitted and the host cuts at the latest completed turn.
       *
       * `increaseTitle` matches the host's own forking, so the child is titled
       * as a branch instead of inheriting the parent's title verbatim.
       *
       * The host refuses to fork a Session whose log has not been opened yet
       * (`migration-required`), so this waits on a retained reference first.
       */
      const onSideChat = React.useCallback(() => {
        const current = selection;
        if (current === null) return;
        const source = current.sessionId;
        const atSeq = seqForTurn(source, current.turn);
        consume(current.text);
        // No "opening…" notice: an `info` notice is an inline banner with no
        // timer, so it would sit in the composer until something replaced it —
        // indistinguishable from a hang. Only the failure gets surfaced, and as
        // an `error`, which the host turns into a toast that dismisses itself.
        // Whatever happens below this settles: a fork that never answers must
        // not leave the reader with no way to learn why.
        const steps = (async () => {
          if (ctx.sessions.scope(source) === undefined) {
            await ctx.sessions.using(
              source,
              { source: 'controllerOperation' },
              async (reference) => reference.ready,
            );
          }
          // Reveal the column first. `openResource` only places a tab into a
          // surface the column has already adopted, and it fails silently when
          // none exists — opening the column is what makes that surface exist.
          ctx.layout.openRightbar(true, false);
          const childId = await ctx.sessions.fork({
            sessionId: source,
            increaseTitle: true,
            ...(atSeq === undefined ? {} : { atSeq }),
          });
          if (childId === undefined || childId === null) throw new Error('fork returned no child id');
          const address = `${SIDE_ADDRESS}${encodeURIComponent(String(childId))}`;
          // The column adopts its surface during the render that follows, so the
          // place attempt is retried a few frames before giving up on it.
          const placed = await openWithRetry(ctx, address);
          if (!placed) throw new Error(`tab never appeared for ${address}`);
          return String(childId);
        })();
        // Timers come from the injected `timer` service rather than browser
        // globals: the dynamic client sandbox withholds `window.setTimeout`
        // from plugin code, and reaching for it is what refuses the whole entry.
        let timerHandle;
        const timeout = new Promise((_, reject) => {
          timerHandle = ctx.timer.timeout(() => reject(new Error('timed out after 15s')), SIDE_TIMEOUT_MS);
        });
        Promise.race([steps, timeout])
          .finally(() => {
            if (typeof timerHandle === 'function') timerHandle();
          })
          .catch((error) => {
          // Report through the failed Session's own composer: by the time this
          // runs the toolbar is gone, so a notice raised from the closure's
          // facade would be written to a facade nobody is rendering.
          const detail = String(error?.message ?? error);
          // A fork is only defined from a completed turn, so a session whose
          // first answer has not settled cannot branch (`session/fork-unavailable`).
          // That is expected, not a defect — give it its own actionable text
          // instead of the retry-me fallback with the raw host error.
          const nothingToFork = /fork-unavailable|no completed turn/.test(detail);
          const message = nothingToFork ? t('sideChatNothingToFork') : `${t('sideChatFailed')} — ${detail}`;
          reportSideFailure(ctx, source, message);
        });
      }, [selection, ctx, t, consume, seqForTurn]);

      if (selection === null) return null;

      return React.createElement(
        React.Fragment,
        null,
        React.createElement('style', { 'data-plugin': '@local/dsh-selection-toolbar' }, STYLE),
        React.createElement(
          'div',
          {
            ref: boxRef,
            className: 'dshSt_root',
            role: 'toolbar',
            'aria-label': t('label'),
            style: { visibility: placed ? 'visible' : 'hidden' },
            // Keep the transcript selection visible while the button is pressed.
            onMouseDown: (event) => event.preventDefault(),
          },
          React.createElement(
            'button',
            { type: 'button', className: 'dshSt_btn', onClick: onAdd },
            React.createElement(IconAdd, null),
            React.createElement('span', null, t('addToChat')),
          ),
          React.createElement(
            'button',
            { type: 'button', className: 'dshSt_btn', onClick: onSideChat },
            React.createElement(IconSide, null),
            React.createElement('span', null, t('sideChat')),
          ),
        ),
      );
    }

    /**
     * Read the Session id out of a side-conversation address.
     * @param address - a full `dsh-resource://selectionchat/session/<id>` address.
     * @returns the Session id, or undefined when the address is not ours.
     */
    function parseSideAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(SIDE_ADDRESS)) return undefined;
      const raw = address.slice(SIDE_ADDRESS.length);
      if (raw === '') return undefined;
      try {
        return decodeURIComponent(raw);
      } catch {
        return undefined;
      }
    }

    /**
     * The resource provider behind a side-conversation tab.
     * It retains the forked Session and hands the tab body the reference it
     * needs, then parks until the tab's lifetime ends. Retaining here (rather
     * than in the body) is what keeps the reference identity stable across
     * re-renders, which `SessionProvider` requires.
     * @param sessions - the Client sessions service.
     * @returns the provider registered for the protocol.
     */
    function sideChatProvider(sessions) {
      return {
        protocol: SIDE_PROTOCOL,
        async *open(resourceAddress, { signal }) {
          const sessionId = parseSideAddress(resourceAddress);
          if (sessionId === undefined) throw new Error(`selection-toolbar: invalid side address "${resourceAddress}"`);
          const reference = sessions.retain(sessionId, { source: 'sidebarView', signal });
          try {
            yield { ok: true, value: { sessionId, reference } };
            await new Promise((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', () => resolve(), { once: true });
            });
          } finally {
            reference.release();
          }
        },
      };
    }

    /**
     * Surface a side-conversation failure on the Session that raised it.
     * It re-resolves the composer facade instead of reusing the one captured
     * when the toolbar was clicked: that facade belongs to a render which has
     * since unmounted, so notifying through it would write to a dead surface.
     * @param ctx - Client context.
     * @param sessionId - the Session whose action failed.
     * @param message - already-translated failure text.
     */
    function reportSideFailure(ctx, sessionId, message) {
      try {
        const actx = ctx.sessions.scope(sessionId);
        const conversation = actx?.get('conversation');
        if (conversation !== undefined) {
          conversation.input.for(actx).notify('error', message);
          return;
        }
      } catch {
        // fall through to the console channel below
      }
      // Last resort: a Session generation that closed mid-flight has no composer
      // to notify, and silence would leave the reader with an action that did
      // nothing. Log it so the failure stays diagnosable instead of vanishing.
      console.error('[selection-toolbar]', message);
    }

    /**
     * Reveal a resource tab, retrying until the tab inventory shows it.
     * The right column places tabs into a surface it adopts while rendering, so
     * an open issued in the same tick as `openRightbar` can land before that
     * surface exists and be dropped. `openResource` returns void and swallows
     * that case, so the only trustworthy answer is the column's own inventory:
     * keep issuing the open until the tab it names is listed there.
     *
     * Repeating the open is safe because a resource tab is identified by its
     * address, so a later attempt reveals the tab an earlier one placed instead
     * of creating a duplicate.
     * @param ctx - Client context carrying the column controller.
     * @param address - the resource address to reveal.
     * @returns whether the tab is listed in the inventory.
     */
    async function openWithRetry(ctx, address) {
      const listed = () => {
        try {
          const tabs = ctx.sidebarRight.openTabs.getSnapshot();
          return Array.isArray(tabs) && tabs.some((tab) => tab.contentId === address);
        } catch {
          return false;
        }
      };
      for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
        try {
          ctx.sidebarRight.openResource(address);
        } catch {
          // A column with no mounted surface throws; that state is temporary
          // right after the column is revealed, so keep trying.
        }
        if (listed()) return true;
        await new Promise((resolve) => {
          // `timer.timeout(callback, ms)` is the injected face of the same wait.
          ctx.timer.timeout(resolve, OPEN_RETRY_MS);
        });
        if (listed()) return true;
      }
      return false;
    }

    /**
     * Fixed Chat selection for the embedded Conversation occurrence: the side
     * tab always shows the chat view, never another Conversation view.
     * @param props - the Conversation views slot's render props.
     * @returns the chat view only.
     */
    function FixedChatConversationView(props) {
      return React.createElement(
        React.Fragment,
        null,
        props.renderSlot('conversation.session', { view: 'chat' }),
      );
    }

    /**
     * The occupant of the side tab's `sidebar.chat.conversation` seat.
     * It reads the bound child Session's shell state only to pick the
     * Conversation panel's phase — settling while the retained Session is still
     * opening, hero while it has no turns yet, active otherwise — and then hands
     * rendering to the host's own `conversation.content` factory with the
     * embedded variant. This mirrors the shipped `SidebarChatTab` panel of the
     * product's subagent sidebar, which is the native precedent for "one
     * Session's conversation in a right-Sidebar tab".
     *
     * Props come from the seat's session scope: `sessionId`, the three snapshot
     * hooks, and `renderFactorySlot` are standard props of a session-scoped
     * slot occupant.
     * @param props - session-scoped standard props of the seat.
     * @returns the embedded Conversation.
     */
    function SideConversationPanel(props) {
      const { sessionId, useSession, useConversation, useSessions, renderFactorySlot } = props;
      const session = useSession((value) => value);
      const shellPhase = useConversation((value) => value).activeTargets.size > 0
        || (!session.blank && !session.awaitingFirstTurn)
        || session.running
        ? 'active'
        : session.promptAttempted ? 'engaging' : 'blank';
      const summaryBlank = useSessions((state) => state.byId[sessionId]?.blank);
      const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true;
      const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true);
      return renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: settling ? 'settling' : hero ? 'hero' : 'active',
        hero,
      }, { slots: { views: FixedChatConversationView } });
    }

    /**
     * The tab body: binds the forked Session and renders the conversation seat.
     * The seat's occupant (`SideConversationPanel`, registered beside this
     * body) draws the actual Conversation; this component only pairs the
     * retained Session reference with that seat — the same split the shipped
     * subagent sidebar tab uses.
     * @param props - slot-injected runtime for the tab.
     * @returns the side conversation, or nothing while the resource opens.
     */
    function SideChatTab(props) {
      const { useResource, useTabInfo, SessionProvider, renderSlot } = props;
      const { tab } = useTabInfo();
      // A resource tab's contentId is its recorded address.
      const resource = useResource(tab.contentId);
      return React.createElement(
        'div',
        { className: 'dshSt_sideTab', 'data-selection-side-chat': '' },
        React.createElement('style', { 'data-plugin': '@local/dsh-selection-toolbar' }, STYLE),
        resource.value === undefined ? null : React.createElement(
          SessionProvider,
          { session: resource.value.reference },
          renderSlot(SIDE_SEAT, {}),
        ),
      );
    }

    return {
      // `timer` is required, not optional: the dynamic client sandbox withholds
      // browser timer globals, so every wait this plugin performs goes through
      // the injected service.
      inject: ['slots', 'sessions', 'conversation', 'locale', 'inputTriggers',
        'resources', 'sidebarRight', 'sidebarRightTabs', 'uiConversation', 'layout', 'timer'],
      apply(ctx) {
        /**
         * Run ONE browser-side contribution, degrading its failure to a
         * `console.error` instead of throwing into the DSH loader. A throw
         * during `apply` — or inside a `ctx.slots.inject` callback, which the
         * slot runtime invokes synchronously while the slot is already
         * declared — fails the whole entry, and the page boots with "entry did
         * not activate". Every registration below is therefore guarded at this
         * one boundary (the `dsh-workbuddy-connect` / `dsh-liangshen`
         * convention), so one broken seam leaves the rest of the plugin alive
         * and the cause visible in the console.
         * @param label - contribution name for the degradation log.
         * @param register - the registering call.
         * @returns a disposer; the noop stands in for a degraded registration.
         */
        const guard = (label, register) => {
          try {
            return register() ?? (() => {});
          } catch (error) {
            console.error(`[selection-toolbar] contribution "${label}" failed to load (rest of the plugin unaffected):`, error);
            return () => {};
          }
        };

        // `locale.register` throws on a namespace re-registration, which a
        // re-applied fiber can hit; degrading only loses the toolbar's copy.
        ctx.effect(() => guard('locale copy', () => ctx.locale.register(NS, DICT)));
        // `bind` outside the guard would defeat it: a failed registration would
        // still take the whole entry down here. Fall back to a translator that
        // echoes the key so the toolbar stays usable with default copy.
        const bindLocale = () => {
          try {
            return ctx.locale.bind(NS);
          } catch (error) {
            console.error('[selection-toolbar] locale bind failed; using key names:', error);
            return (key) => key;
          }
        };
        const t = bindLocale();
        /** @returns the provenance note for one turn, in the active UI language. */
        const turnNote = (turn) => t('turn', { turn: String(turn) });
        // The chip's owner: an empty trigger source whose only job is to supply
        // the serializer that expands the chip back into the quoted passage.
        // Duplicate (trigger, name) pairs throw, so the guard absorbs a re-apply.
        ctx.effect(() => guard('quote serializer', () => ctx.inputTriggers.registerSource({
          trigger: '@',
          name: SOURCE_NAME,
          candidates: async () => [],
          onPick: () => undefined,
          codec: {
            // Copying the draft yields the number the reader sees in the chip.
            clipboardText: (ref) => {
              const { number } = decodeRef(ref);
              return number === null ? ref : `#${number}`;
            },
            // The model receives the number as a marker, the turn it came from
            // when known, and then the passage, so it can refer back to `#3`,
            // locate that passage in the history, and still read what it said.
            serialize: async (ref) => {
              const { number, turn, text } = decodeRef(ref);
              if (number === null) return text;
              const origin = turn === null ? '' : ` (${turnNote(turn)})`;
              return `[#${number}]${origin} ${text}`;
            },
          },
        })));
        ctx.slots.inject(SLOT, () => guard('overlay toolbar', () => ctx.slots.register({
          name: SLOT,
          id: ENTRY_ID,
          order: 10,
        }, () => React.createElement(SelectionToolbar, { ctx }))));

        // Side conversations: the provider retains the forked Session, the tab
        // type ties the address to the body, and the body draws that Session's
        // own embedded Conversation. Each seam degrades independently: a
        // refused provider or tab type leaves the quoting toolbar working.
        ctx.effect(() => guard('side-chat resource provider', () => ctx.resources.register(sideChatProvider(ctx.sessions))));
        ctx.effect(() => guard('side-chat tab type', () => ctx.sidebarRightTabs.register({
          id: SIDE_TAB_ID,
          kind: SIDE_KIND,
          patterns: [`${SIDE_ADDRESS}**`],
          priority: 'extension',
          canOpen: (address) => parseSideAddress(address) !== undefined,
          title: () => t('sideChatTitle'),
        })));
        // The pane-seat registration cannot ride `slots.inject`: this bundle
        // boots with `immediately: true`, before the rightbar entry declares
        // `sidebar.right.pane.tab`, and a declaration-triggered inject callback
        // never reached us in that order.
        //
        // Every call used to discover or follow that seat is therefore treated
        // as optional: `spec`/`subscribe` are not on the sandbox's published
        // SlotRegistry face, so touching them can reject the whole entry. Each
        // is probed with `typeof` first and simply skipped when absent, leaving
        // the quoting toolbar fully functional.
        const registerSideBody = () => guard('side-chat tab body', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: SIDE_TAB_ID,
          // The body needs `SessionProvider` and `renderSlot`, and the slot
          // runtime synthesizes both only for an entry that declares children:
          // `SessionProvider` is installed solely when a declared child has a
          // non-root scope. Declaring this child is what lets the body bind a
          // Session at all, and it also declares the seat its occupant fills.
          children: { [SIDE_SEAT]: { kind: 'single', scope: 'session' } },
        }, SideChatTab));
        /**
         * Register the occupant of the child seat the body declared.
         * This must only run once the body registration actually landed: a seat
         * nobody declared rejects an occupant with SlotOwnershipError, so an
         * occupant registered after a degraded body would throw every time.
         * @returns whether the occupant was attempted.
         */
        const registerSideOccupant = () => {
          try {
            if (typeof ctx.slots.spec === 'function' && ctx.slots.spec(SIDE_SEAT) === undefined) return false;
          } catch {
            return false;
          }
          return guard('side-chat conversation occupant', () => ctx.slots.register(
            { name: SIDE_SEAT },
            SideConversationPanel,
          )) !== undefined;
        };
        /**
         * Register both side-chat seats if the host already declared the pane
         * seat. @returns whether registration is settled (done or unreachable).
         */
        const tryRegisterSideSeats = () => {
          try {
            // Without a published `spec` there is no way to ask whether the
            // pane seat exists; registering blind is safe because an occupied
            // key is defined as replacement, so attempt it and let `guard`
            // absorb a refusal.
            if (typeof ctx.slots.spec === 'function' && ctx.slots.spec('sidebar.right.pane.tab') === undefined) {
              return false;
            }
            registerSideBody();
            registerSideOccupant();
            return true;
          } catch (error) {
            console.error('[selection-toolbar] side-chat seats not registered:', error);
            return true;
          }
        };
        if (!tryRegisterSideSeats() && typeof ctx.slots.subscribe === 'function') {
          const unsubscribe = ctx.slots.subscribe('sidebar.right.pane.tab', () => {
            if (tryRegisterSideSeats()) unsubscribe();
          });
        }
      },
    };
  },
});
