import React, { createContext, memo, useCallback, useContext, useMemo, useState } from 'react';
import { useClosedCaption } from '../../hooks/use-closed-caption';
import styles from './closed-captions.module.css';

type ClosedCaptionsContextValue = {
	isEnabled: boolean;
	toggle: () => void;
};

const ClosedCaptionsContext = createContext<ClosedCaptionsContextValue | null>(null);

export const ClosedCaptionsProvider = ({
	children,
	defaultEnabled = false,
}: {
	children: React.ReactNode;
	defaultEnabled?: boolean;
}) => {
	const [isEnabled, setIsEnabled] = useState(defaultEnabled);
	const toggle = useCallback(() => setIsEnabled((v) => !v), []);
	const value = useMemo(() => ({ isEnabled, toggle }), [isEnabled, toggle]);
	return <ClosedCaptionsContext.Provider value={value}>{children}</ClosedCaptionsContext.Provider>;
};

export const useClosedCaptionsContext = (): ClosedCaptionsContextValue => {
	const ctx = useContext(ClosedCaptionsContext);
	if (!ctx) {
		throw new Error('ClosedCaptions components must be used within <ClosedCaptionsProvider>');
	}
	return ctx;
};

export const ClosedCaptionsButton = memo(() => {
	const { isEnabled, toggle } = useClosedCaptionsContext();

	return (
		<button
			type="button"
			onClick={toggle}
			aria-pressed={isEnabled}
			className={`${styles.captionButton} ${isEnabled ? styles.captionButtonActive : ''}`}
		>
			<span className={styles.captionButtonIcon}>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					role="img"
					aria-label={isEnabled ? 'Closed Captions On' : 'Closed Captions Off'}
				>
					<rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
					<path
						d="M10 11C10 10.4477 9.55228 10 9 10H8C7.44772 10 7 10.4477 7 11V13C7 13.5523 7.44772 14 8 14H9C9.55228 14 10 13.5523 10 13"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
					/>
					<path
						d="M17 11C17 10.4477 16.5523 10 16 10H15C14.4477 10 14 10.4477 14 11V13C14 13.5523 14.4477 14 15 14H16C16.5523 14 17 13.5523 17 13"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
					/>
				</svg>
			</span>
			<span className={styles.srOnly}>Closed Captions</span>
		</button>
	);
});

ClosedCaptionsButton.displayName = 'ClosedCaptionsButton';

export const ClosedCaptions = memo(() => {
	const { isEnabled } = useClosedCaptionsContext();
	const caption = useClosedCaption();

	if (!isEnabled || !caption || !caption.text) {
		return null;
	}

	return (
		<div className={styles.container} role="status" aria-live="polite">
			<span
				className={`${styles.role} ${caption.role === 'replica' ? styles.roleReplica : styles.roleUser}`}
			>
				{caption.role === 'replica' ? 'Replica' : 'You'}
			</span>
			<span className={styles.text}>
				<span className={styles.textInner}>{caption.text}</span>
			</span>
		</div>
	);
});

ClosedCaptions.displayName = 'ClosedCaptions';
