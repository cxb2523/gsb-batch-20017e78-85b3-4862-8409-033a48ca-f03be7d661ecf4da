// Решение «что делать при неудачной сборке» — вынесено из Group, чтобы покрыть тестом.
// Пока звучит старая программа, её нельзя снимать: иначе блок на мгновение замолкает или
// перескакивает. Причина при этом всё равно показывается пользователю.

export type TFailureResult<T> = {
  // Причина для лица блока
  error: string;
  // Программа, которая продолжает звучать (null — блок звучит своими нодами)
  keep: T | null;
};

// Ошибка разбора/сборки: старую программу не трогаем, если она есть
export const compileFailure = <T,>(reason: string, program: T | null): TFailureResult<T> => ({
  error: reason,
  keep: program,
});

// Рантайм-ошибка процессора (onprocessorerror): текущая программа уже мертва, нужен откат
// на живые ноды — иначе была бы тишина
export const runtimeFailure = <T,>(reason: string): TFailureResult<T> => ({
  error: reason,
  keep: null,
});
