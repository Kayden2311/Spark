import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} viewBox="0 0 24 24" {...props}>
      {children}
    </svg>
  );
}

export const OverviewIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Icon>;
export const FlagIcon = (p: IconProps) => <Icon {...p}><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></Icon>;
export const CommunityIcon = (p: IconProps) => <Icon {...p}><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9.5" r="2.5" /><path d="M3 20c.6-3.6 2.8-5.5 6-5.5s5.4 1.9 6 5.5M15.5 14.6c2.9-.2 4.8 1.4 5.5 4.4" /></Icon>;
export const MegaphoneIcon = (p: IconProps) => <Icon {...p}><path d="M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1ZM15 8.5a4 4 0 0 1 0 7M18 6a7.5 7.5 0 0 1 0 12" /></Icon>;
export const UserIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-4 3.8-6 8-6s7.2 2 8 6" /></Icon>;
export const AuditIcon = (p: IconProps) => <Icon {...p}><path d="M7 3h8l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M15 3v4h4M9 12h6M9 16h6" /></Icon>;
export const LogoutIcon = (p: IconProps) => <Icon {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" /></Icon>;
export const HomeIcon = (p: IconProps) => <Icon {...p}><path d="m4 11 8-7 8 7M6 9.5V20h12V9.5" /></Icon>;
export const MenuIcon = (p: IconProps) => <Icon {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Icon>;
export const CloseIcon = (p: IconProps) => <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>;
export const SearchIcon = (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></Icon>;
export const CheckIcon = (p: IconProps) => <Icon {...p}><path d="m5 12 5 5 9-10" /></Icon>;
export const AlertIcon = (p: IconProps) => <Icon {...p}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17h.01" /></Icon>;
export const ShieldIcon = (p: IconProps) => <Icon {...p}><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></Icon>;
export const ClockIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
export const PulseIcon = (p: IconProps) => <Icon {...p}><path d="M3 12h4l3-7 4 14 3-7h4" /></Icon>;
export const ChevronIcon = (p: IconProps) => <Icon {...p}><path d="m9 6 6 6-6 6" /></Icon>;
export const RefreshIcon = (p: IconProps) => <Icon {...p}><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4" /></Icon>;
export const InboxIcon = (p: IconProps) => <Icon {...p}><path d="M4 13 6.5 5h11L20 13v6H4v-6Z" /><path d="M4 13h5l1 2h4l1-2h5" /></Icon>;
export const MoreIcon = (p: IconProps) => <Icon {...p}><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" /></Icon>;
export const ExternalIcon = (p: IconProps) => <Icon {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Icon>;
export const ArrowLeftIcon = (p: IconProps) => <Icon {...p}><path d="M19 12H5M11 6l-6 6 6 6" /></Icon>;
export const ArrowUpIcon = (p: IconProps) => <Icon {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Icon>;
export const ArrowDownIcon = (p: IconProps) => <Icon {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Icon>;
export const ChartIcon = (p: IconProps) => <Icon {...p}><path d="M4 4v16h16" /><path d="m8 14 3-3 3 2 5-6" /></Icon>;
export const BillingIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h4" /></Icon>;
export const SidebarIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Icon>;
export const BoardIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1" /></Icon>;
export const ListIcon = (p: IconProps) => <Icon {...p}><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></Icon>;
export const DownloadIcon = (p: IconProps) => <Icon {...p}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></Icon>;
export const KeyboardIcon = (p: IconProps) => <Icon {...p}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></Icon>;
export const TrendIcon = (p: IconProps) => <Icon {...p}><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></Icon>;
export const SignupIcon = (p: IconProps) => <Icon {...p}><circle cx="10" cy="8" r="4" /><path d="M3 21c.7-3.8 3.4-6 7-6 1.4 0 2.6.3 3.7.9M19 15v6M16 18h6" /></Icon>;
export const ChatIcon = (p: IconProps) => <Icon {...p}><path d="M4 5h16v11H9l-5 4V5Z" /></Icon>;
