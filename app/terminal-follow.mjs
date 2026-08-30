export const FOLLOW_THRESHOLD_PX = 72;

export function isNearBottom({ scrollTop, scrollHeight, clientHeight }, threshold = FOLLOW_THRESHOLD_PX) {
  return scrollHeight - clientHeight - scrollTop <= threshold;
}

export function nextFollowState({ initial, following, contentChanged }) {
  if (initial) return { scroll: true, unseen: false };
  if (!contentChanged) return { scroll: false, unseen: false };
  return following ? { scroll: true, unseen: false } : { scroll: false, unseen: true };
}
