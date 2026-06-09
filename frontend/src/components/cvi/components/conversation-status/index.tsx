import React, { memo } from 'react';
import styles from './conversation-status.module.css';

const GRID_SIZE = 144;
const CONNECT_STAGGER_S = 1.8;
const LEAVE_STAGGER_S = 1.0;

// Pre-shuffled positions, computed once at module load. Each square gets a
// stable position in the random fill order so re-renders never re-shuffle.
const SHUFFLED_ORDER: number[] = (() => {
	const order = Array.from({ length: GRID_SIZE }, (_, i) => i);
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}
	return order;
})();

// Per-square target opacity, ranged 0.25–0.75, gives the grid a dithered
// look so cells don't all read at the same brightness when filled.
const TARGET_OPACITY: number[] = Array.from(
	{ length: GRID_SIZE },
	() => 0.25 + Math.random() * 0.5
);

// Per-square Bayer pattern offset (0–7px on each axis) so the dither
// patterns don't line up across cells — adds visual noise to the grid.
const DITHER_OFFSETS: string[] = Array.from({ length: GRID_SIZE }, () => {
	const x = Math.floor(Math.random() * 8);
	const y = Math.floor(Math.random() * 8);
	return `${x}px ${y}px`;
});

const Grid = ({ leaving = false }: { leaving?: boolean }) => {
	const squareClass = leaving ? styles.squareLeaving : styles.squareConnecting;
	const totalStagger = leaving ? LEAVE_STAGGER_S : CONNECT_STAGGER_S;
	return (
		<div className={styles.grid} aria-hidden="true">
			{Array.from({ length: GRID_SIZE }, (_, i) => {
				const delay = (SHUFFLED_ORDER[i] / GRID_SIZE) * totalStagger;
				const style = {
					'--fill-delay': `${delay.toFixed(3)}s`,
					'--target-opacity': TARGET_OPACITY[i].toFixed(2),
					'--dither-offset': DITHER_OFFSETS[i],
				} as React.CSSProperties;
				return <span key={i} className={`${styles.square} ${squareClass}`} style={style} />;
			})}
		</div>
	);
};

const Dots = () => (
	<>
		<span className={styles.dot}>.</span>
		<span className={styles.dot}>.</span>
		<span className={styles.dot}>.</span>
	</>
);

export const ConnectingState = memo(() => (
	<div className={styles.statusContainer} role="status" aria-live="polite">
		<Grid />
		<div className={`${styles.label} ${styles.labelConnecting}`}>
			<span className={styles.labelText}>
				Connecting
				<Dots />
			</span>
		</div>
	</div>
));

ConnectingState.displayName = 'ConnectingState';

export const LeavingState = memo(() => (
	<div className={styles.statusContainer} role="status" aria-live="polite">
		<Grid leaving />
		<div className={`${styles.label} ${styles.labelLeaving}`}>
			<span className={styles.labelText}>
				Leaving
				<Dots />
			</span>
		</div>
	</div>
));

LeavingState.displayName = 'LeavingState';
