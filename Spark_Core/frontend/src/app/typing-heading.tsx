"use client";

import { useEffect, useRef, useState } from "react";

type TypingHeadingProps = {
  as?: "h1" | "h2";
  className?: string;
  children: string;
  accentFrom?: number;
  id?: string;
};

export function TypingHeading({ as: Tag = "h2", children, className, accentFrom, id }: TypingHeadingProps) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [typedCharacters, setTypedCharacters] = useState(Tag === "h1" ? 0 : -1);
  let characterIndex = 0;

  useEffect(() => {
    if (Tag === "h1" || !ref.current) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setTypedCharacters(0), { threshold: 0.25 });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [Tag]);

  useEffect(() => {
    if (typedCharacters < 0 || typedCharacters >= children.length) return;
    const timer = window.setTimeout(() => setTypedCharacters((count) => count + 1), 18);
    return () => window.clearTimeout(timer);
  }, [children.length, typedCharacters]);

  return <Tag ref={ref} id={id} className={className} aria-label={children} data-typing-visible={typedCharacters >= 0}>
    {children.split(/(\s+)/).map((token, tokenIndex) => {
      if (/^\s+$/.test(token)) {
        // A plain space lets the browser drop it at a line wrap instead of indenting the next line.
        characterIndex++;
        return " ";
      }
      return <span className="typingHeadingWord" key={`word-${tokenIndex}`}>{Array.from(token).map((character) => {
        const index = characterIndex++;
        return <span aria-hidden="true" className={`typingHeadingCharacter${index < typedCharacters ? " typingHeadingCharacterVisible" : ""}${accentFrom !== undefined && index >= accentFrom ? " typingHeadingAccent" : ""}`} key={`${character}-${index}`}>{character}</span>;
      })}</span>;
    })}
  </Tag>;
}
