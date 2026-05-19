import { useRef } from "react";

// Returns mousedown/click handlers for a modal backdrop that close on click
// *only when the click started on the backdrop itself*. This avoids the case
// where a text-drag inside the modal ends up releasing the mouse over the
// backdrop and unintentionally dismissing the dialog.
//
// Usage:
//   const backdrop = useBackdropClose(onClose);              // always closeable
//   const backdrop = useBackdropClose(busy ? undefined : onClose); // disable while busy
//   <div className="modal-backdrop" {...backdrop}>
export function useBackdropClose(onClose: (() => void) | undefined) {
    const startedOnBackdrop = useRef(false);
    return {
        onMouseDown: (e: React.MouseEvent) => {
            startedOnBackdrop.current = e.target === e.currentTarget;
        },
        onClick: (e: React.MouseEvent) => {
            if (onClose && startedOnBackdrop.current && e.target === e.currentTarget) {
                onClose();
            }
        },
    };
}
