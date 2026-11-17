import Image from "next/image";
import appIcon from "../app/icon.png";

export function BrandMark({ small = false }: { small?: boolean }) {
  const size = small ? 22 : 31;

  return (
    <span aria-hidden="true" className={small ? "brand-mark brand-mark-small" : "brand-mark"}>
      <Image alt="" height={size} src={appIcon} width={size} />
    </span>
  );
}
