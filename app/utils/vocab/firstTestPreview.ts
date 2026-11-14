/** 首考前预习的界面状态：只记当前词和已经看过释义的词，不碰数据库。 */
export interface FirstTestPreviewState {
  index: number;
  revealed: boolean;
  previewed: ReadonlySet<string>;
}

export function initialFirstTestPreview(): FirstTestPreviewState {
  return { index: 0, revealed: false, previewed: new Set() };
}

/** 看释义不可逆；重复点也不会重复记录。 */
export function revealFirstTestDefinition(state: FirstTestPreviewState, wordId: string): FirstTestPreviewState {
  if (state.revealed) return state;
  return { ...state, revealed: true, previewed: new Set([...state.previewed, wordId]) };
}

/** 只前进、不后退；没看过的词不会偷偷加入 previewed。 */
export function advanceFirstTestPreview(state: FirstTestPreviewState): FirstTestPreviewState {
  return { ...state, index: state.index + 1, revealed: false };
}
