import { useTranslation } from 'react-i18next';

import { cn } from '@/platform/lib/tailwind/utils';

import { envClient } from '@/platform/env/client';

import type { Book } from './schema';

export const BookCover = (props: {
  book: Partial<Pick<Book, 'genre'>> & {
    author?: string | null;
    coverId?: string | null;
    title?: string | null;
  };
  variant?: 'default' | 'tiny';
  className?: string;
  viewTransitionName?: string;
}) => {
  const { t } = useTranslation(['book']);

  return (
    <div
      className={cn(
        '@container relative flex aspect-[2/3] flex-col justify-between overflow-hidden rounded-sm bg-book-cover p-[10%] pl-[16%] text-book-cover-foreground shadow-2xl',
        props.variant === 'tiny' && 'w-8 rounded-xs',
        props.className
      )}
      style={{
        ...(!props.book.coverId
          ? {
              backgroundColor:
                props.book.genre?.color ?? 'var(--book-cover-fallback)',
            }
          : {}),
        ...(props.viewTransitionName
          ? { viewTransitionName: props.viewTransitionName }
          : {}),
      }}
    >
      <div className="absolute inset-y-0 left-0 z-10 w-[5%] bg-gradient-to-r from-book-cover-shadow-transparent to-book-cover-shadow-subtle bg-blend-screen" />
      <div className="absolute inset-y-0 left-[5%] z-10 w-[2%] bg-gradient-to-r from-book-cover-glare-transparent to-book-cover-glare-subtle bg-blend-screen" />
      <div className="absolute inset-y-0 left-[7%] z-10 w-[2%] bg-gradient-to-r from-book-cover-glare-transparent to-book-cover-glare-subtle bg-blend-screen" />
      <div className="absolute -top-1/8 -right-1/8 z-10 aspect-square w-3/4 rounded-full bg-book-cover-glare bg-blend-screen blur-xl @6xs:blur-2xl @5xs:blur-3xl" />
      <div className="absolute -bottom-1/8 -left-1/8 z-10 aspect-square w-3/4 rounded-full bg-book-cover-shadow bg-blend-screen blur-xl @6xs:blur-2xl @5xs:blur-3xl" />
      {!!props.book.coverId && (
        <>
          <img
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            src={`${envClient.VITE_S3_BUCKET_PUBLIC_URL}/${props.book.coverId}`}
          />
        </>
      )}
      <div
        className={cn(
          'relative flex flex-1 flex-col justify-between',
          !!props.book.coverId && 'sr-only'
        )}
      >
        <h3
          className={cn(
            'text-sm leading-tight font-bold break-words @6xs:text-base @5xs:text-lg @4xs:text-xl',
            props.variant === 'tiny' && 'text-[2px]'
          )}
        >
          {props.book.title ?? ''}
        </h3>
        <div className="flex flex-col">
          {!!props.book.author && (
            <p
              className={cn(
                'text-xs break-words opacity-60',
                props.variant === 'tiny' && 'text-[1px]'
              )}
            >
              {t('book:common.byCapitalized')} {props.book.author}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
