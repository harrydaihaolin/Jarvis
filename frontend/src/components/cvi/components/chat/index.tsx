import React, {
	createContext,
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { useChat, type ChatMessage } from '../../hooks/use-chat';
import styles from './chat.module.css';

type ChatContextValue = {
	isOpen: boolean;
	toggle: () => void;
	close: () => void;
	messages: ChatMessage[];
	sendMessage: (text: string) => void;
	conversationId: string | null;
};

const ChatContext = createContext<ChatContextValue | null>(null);

export const ChatProvider = ({
	children,
	defaultOpen = false,
}: {
	children: React.ReactNode;
	defaultOpen?: boolean;
}) => {
	const [isOpen, setIsOpen] = useState(defaultOpen);
	const { messages, sendMessage, conversationId } = useChat();
	const toggle = useCallback(() => setIsOpen((v) => !v), []);
	const close = useCallback(() => setIsOpen(false), []);
	const value = useMemo(
		() => ({ isOpen, toggle, close, messages, sendMessage, conversationId }),
		[isOpen, toggle, close, messages, sendMessage, conversationId]
	);
	return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

const useChatContext = (): ChatContextValue => {
	const ctx = useContext(ChatContext);
	if (!ctx) {
		throw new Error('Chat components must be used within <ChatProvider>');
	}
	return ctx;
};

// Text at or above this length is treated as a "large paste": abbreviated in the
// composer (pill) and collapsed in the message history (expand-on-demand).
const PASTE_THRESHOLD = 500;

export const ChatButton = memo(() => {
	const { isOpen, toggle } = useChatContext();
	return (
		<button
			type="button"
			onClick={toggle}
			aria-pressed={isOpen}
			aria-label={isOpen ? 'Close chat' : 'Open chat'}
			className={`${styles.chatButton} ${isOpen ? styles.chatButtonActive : ''}`}
		>
			<span className={styles.chatButtonIcon}>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					aria-hidden="true"
					focusable="false"
				>
					<path
						d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</span>
		</button>
	);
});

ChatButton.displayName = 'ChatButton';

const MessageBubble = memo(({ message }: { message: ChatMessage }) => {
	const isUser = message.role === 'user';
	const isLargePaste = isUser && message.text.length >= PASTE_THRESHOLD;
	const [expanded, setExpanded] = useState(false);
	return (
		<li
			className={`${styles.messageRow} ${isUser ? styles.messageRowUser : styles.messageRowReplica}`}
		>
			<span
				className={`${styles.messageRole} ${
					isUser ? styles.messageRoleUser : styles.messageRoleReplica
				}`}
			>
				{isUser ? 'You' : 'Replica'}
			</span>
			<span
				className={`${styles.messageBubble} ${
					isUser ? styles.messageBubbleUser : styles.messageBubbleReplica
				}`}
			>
				{isLargePaste ? (
					<span className={styles.pasteMessage}>
						<span className={styles.pasteMessageMeta}>
							📋 Pasted text · {message.text.length.toLocaleString()} chars
						</span>
						<button
							type="button"
							className={styles.pasteMessageToggle}
							onClick={() => setExpanded((v) => !v)}
							aria-expanded={expanded}
						>
							{expanded ? 'Hide ▴' : 'Show full ▾'}
						</button>
						{expanded && <span className={styles.pasteMessageFull}>{message.text}</span>}
					</span>
				) : (
					message.text
				)}
			</span>
		</li>
	);
});

MessageBubble.displayName = 'MessageBubble';

export const ChatPanel = memo(() => {
	const { isOpen, close, messages, sendMessage, conversationId } = useChatContext();
	const [draft, setDraft] = useState('');
	const [pasteLen, setPasteLen] = useState(0);
	const pastedRef = useRef<string | null>(null);
	const listRef = useRef<HTMLUListElement | null>(null);

	useEffect(() => {
		const el = listRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages.length]);

	const clearPaste = useCallback(() => {
		pastedRef.current = null;
		setPasteLen(0);
	}, []);

	const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const text = e.clipboardData.getData('text');
		if (text.length >= PASTE_THRESHOLD) {
			// Abbreviate the paste into a pill instead of flooding the textarea.
			e.preventDefault();
			pastedRef.current = text;
			setPasteLen(text.length);
		}
	}, []);

	const submit = useCallback(() => {
		if (!conversationId) {
			return;
		}
		const note = draft.trim();
		const pasted = pastedRef.current;
		// Send the full pasted text (no truncation), optionally followed by the note.
		const toSend = pasted ? (note ? `${pasted}\n\n${note}` : pasted) : note;
		if (!toSend) {
			return;
		}
		sendMessage(toSend);
		setDraft('');
		clearPaste();
	}, [draft, sendMessage, conversationId, clearPaste]);

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
				e.preventDefault();
				submit();
			}
		},
		[submit]
	);

	const canSend = (!!draft.trim() || pasteLen > 0) && !!conversationId;

	return (
		<aside
			className={`${styles.panel} ${isOpen ? styles.panelOpen : ''}`}
			aria-hidden={!isOpen}
			inert={!isOpen}
		>
			<header className={styles.header}>
				<span>Chat</span>
				<button
					type="button"
					className={styles.closeButton}
					onClick={close}
					aria-label="Close chat"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						aria-hidden="true"
						focusable="false"
					>
						<path
							d="M18 6L6 18M6 6l12 12"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
						/>
					</svg>
				</button>
			</header>

			<ul ref={listRef} className={styles.messageList} role="log" aria-live="polite">
				{messages.length === 0 ? (
					<li className={styles.empty}>
						{conversationId ? 'Send a message to start the conversation.' : 'Connecting…'}
					</li>
				) : (
					messages.map((m) => <MessageBubble key={m.id} message={m} />)
				)}
			</ul>

			<form
				className={styles.composer}
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				{pasteLen > 0 && (
					<div className={styles.pastePill}>
						<span className={styles.pastePillLabel}>
							📋 Pasted text · {pasteLen.toLocaleString()} chars
						</span>
						<button
							type="button"
							className={styles.pastePillClose}
							onClick={clearPaste}
							aria-label="Remove pasted text"
						>
							✕
						</button>
					</div>
				)}
				<div className={styles.composerRow}>
					<textarea
						className={styles.composerInput}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={onKeyDown}
						onPaste={onPaste}
						placeholder={
							conversationId
								? pasteLen > 0
									? 'Add a note (optional)…'
									: 'Type a message…'
								: 'Connecting…'
						}
						disabled={!conversationId}
						rows={1}
						aria-label="Message"
					/>
					<button
						type="submit"
						className={styles.sendButton}
						disabled={!canSend}
						aria-label="Send message"
					>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						aria-hidden="true"
						focusable="false"
					>
						<path
							d="M3 12l18-9-9 18-2-7-7-2z"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinejoin="round"
							strokeLinecap="round"
						/>
					</svg>
					</button>
				</div>
			</form>
		</aside>
	);
});

ChatPanel.displayName = 'ChatPanel';
