import type { MnemocyteObservation } from "../../index.js";

/** What {@link trackAccessEvents} returns. */
export interface AccessEvents {
	/** Every `"trackAccess"` event, in order. */
	readonly all: MnemocyteObservation[];
	/** Pass as `observability.onEvent`. */
	onEvent(event: MnemocyteObservation): void;
	/** The next settled event not handed out yet. */
	nextSettled(): Promise<MnemocyteObservation>;
}

/**
 * Collects `"trackAccess"` events and hands out each settled one
 * (`"success"` or `"error"`) once, whether it arrived before or after the
 * test asked for it.
 */
export function trackAccessEvents(): AccessEvents {
	const all: MnemocyteObservation[] = [];
	const settled: MnemocyteObservation[] = [];
	const waiting: Array<(event: MnemocyteObservation) => void> = [];
	return {
		all,
		onEvent(event: MnemocyteObservation): void {
			if (event.operation !== "trackAccess") {
				return;
			}
			all.push(event);
			if (event.phase === "start") {
				return;
			}
			const resolve = waiting.shift();
			if (resolve) {
				resolve(event);
			} else {
				settled.push(event);
			}
		},
		nextSettled(): Promise<MnemocyteObservation> {
			const event = settled.shift();
			return event
				? Promise.resolve(event)
				: new Promise((resolve) => waiting.push(resolve));
		},
	};
}
