"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

type WelcomeRevealProps = {
  children: ReactNode;
  className: string;
};

export function WelcomeReveal({ children, className }: WelcomeRevealProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [isArmed, setIsArmed] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !("IntersectionObserver" in window)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (element.getBoundingClientRect().top <= window.innerHeight) return;

    setIsArmed(true);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const classes = [className, isArmed && "is-pending", isVisible && "is-visible"]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} ref={elementRef}>
      {children}
    </div>
  );
}
