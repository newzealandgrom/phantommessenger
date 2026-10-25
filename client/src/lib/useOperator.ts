import { useEffect, useState } from "react";
import { DEFAULT_OPERATOR, loadOperator, operatorLoaded } from "./operatorInfo";
import type { OperatorInfo } from "./operatorInfo";

/** Данные оператора из /operator.json. `ready` = false, пока файл не прочитан (≤ 3 с): страницы
 *  с юридическим текстом в этот момент ничего не рисуют, чтобы не мелькали чужие контакты. */
export function useOperator(): { op: OperatorInfo; ready: boolean } {
  const [op, setOp] = useState<OperatorInfo | null>(() => operatorLoaded());
  useEffect(() => {
    if (op) return;
    let alive = true;
    void loadOperator().then((v) => { if (alive) setOp(v); });
    return () => { alive = false; };
  }, [op]);
  return { op: op ?? DEFAULT_OPERATOR, ready: op !== null };
}
