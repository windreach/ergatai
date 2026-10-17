import { useState, useCallback, useMemo } from "react";
import { Input } from "../../../../components/ui/input";
import { Button } from "../../../../components/ui/button";
import { cn } from "../../../../lib/utils";
import { LuSearch, LuX } from "react-icons/lu";
import { SearchCombobox } from "../../../../components/ui/search-combobox";
import { PopoverTrigger } from "../../../../components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../../../../components/ui/tooltip";
import { AgentIcon, CircleFilterIcon } from "../../../../components/ui/icons";

export interface ConversationFilterItem {
	id: string;
	name: string;
	filePaths: string[];
	fileCount: number;
}

interface ChangesFileFilterProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
	/** Available conversations for filtering */
	conversations?: ConversationFilterItem[];
	/** Currently selected conversation ID for filtering */
	selectedConversationId?: string | null;
	/** Callback when conversation filter changes */
	onConversationFilterChange?: (conversationId: string | null) => void;
}

export function ChangesFileFilter({
	value,
	onChange,
	placeholder = "Filter files...",
	className,
	conversations = [],
	selectedConversationId,
	onConversationFilterChange,
}: ChangesFileFilterProps) {
	const [isConversationFilterOpen, setIsConversationFilterOpen] = useState(false);

	const selectedConversation = useMemo(() => {
		if (!selectedConversationId) return null;
		return conversations.find((sc) => sc.id === selectedConversationId) || null;
	}, [conversations, selectedConversationId]);

	const handleConversationSelect = useCallback(
		(conversation: ConversationFilterItem) => {
			// Toggle off if same conversation selected
			if (selectedConversationId === conversation.id) {
				onConversationFilterChange?.(null);
			} else {
				onConversationFilterChange?.(conversation.id);
			}
			setIsConversationFilterOpen(false);
		},
		[selectedConversationId, onConversationFilterChange]
	);

	const handleClearConversationFilter = useCallback(() => {
		onConversationFilterChange?.(null);
	}, [onConversationFilterChange]);

	const renderConversationItem = useCallback((conversation: ConversationFilterItem) => {
		return (
			<div className="flex items-center gap-2 flex-1 min-w-0">
				<AgentIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
				<span className="text-sm truncate flex-1">
					{conversation.name || "New Chat"}
				</span>
				<span className="text-xs text-muted-foreground whitespace-nowrap">
					{conversation.fileCount} file{conversation.fileCount !== 1 ? "s" : ""}
				</span>
			</div>
		);
	}, []);

	const hasConversations = conversations.length > 0;

	return (
		<div className={cn("flex flex-col gap-1.5 px-2 py-1.5", className)}>
			{/* Search row */}
			<div className="flex items-center gap-1">
				{/* Search input */}
				<div className="relative flex-1">
					<LuSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
					<Input
						type="search"
						value={value}
						onChange={(e) => onChange(e.target.value)}
						placeholder={placeholder}
						className="h-7 pl-7 pr-7 text-xs bg-muted/50"
					/>
					{value && (
						<button
							type="button"
							onClick={() => onChange("")}
							className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted-foreground/20 transition-colors"
						>
							<LuX className="size-3 text-muted-foreground" />
						</button>
					)}
				</div>

				{/* Conversation filter button */}
				{hasConversations && (
					<SearchCombobox
						isOpen={isConversationFilterOpen}
						onOpenChange={setIsConversationFilterOpen}
						items={conversations}
						onSelect={handleConversationSelect}
						placeholder="Search chats..."
						emptyMessage="No chats with changes"
						getItemValue={(conversation) => `${conversation.name || "New Chat"} ${conversation.id}`}
						renderItem={renderConversationItem}
						side="bottom"
						align="end"
						sideOffset={4}
						collisionPadding={16}
						trigger={
							<Tooltip delayDuration={300}>
								<TooltipTrigger asChild>
									<PopoverTrigger asChild>
										<Button
											variant={selectedConversationId ? "secondary" : "ghost"}
											size="icon"
											className={cn(
												"h-7 w-7 p-0 flex-shrink-0 rounded-md transition-colors",
												selectedConversationId && "bg-primary/10 hover:bg-primary/20"
											)}
										>
											<CircleFilterIcon className={cn(
												"h-4 w-4",
												selectedConversationId ? "text-primary" : "text-muted-foreground"
											)} />
										</Button>
									</PopoverTrigger>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{selectedConversation
										? `Filtering: ${selectedConversation.name || "New Chat"}`
										: "Filter by chat"}
								</TooltipContent>
							</Tooltip>
						}
					/>
				)}
			</div>

			{/* Active conversation filter bar */}
			{selectedConversation && (
				<div className="flex items-center justify-between gap-2 h-7 px-2 rounded-md bg-muted/80 border border-border/50">
					<div className="flex items-center gap-1.5 min-w-0">
						<span className="text-[10px] text-muted-foreground flex-shrink-0 uppercase tracking-wide">
							Filtered
						</span>
						<span className="text-muted-foreground/30 flex-shrink-0">•</span>
						<span className="text-xs text-foreground/80 truncate">
							{selectedConversation.name || "New Chat"}
						</span>
						<span className="text-[10px] text-muted-foreground flex-shrink-0">
							({selectedConversation.fileCount})
						</span>
					</div>
					<button
						type="button"
						onClick={handleClearConversationFilter}
						className="p-0.5 rounded hover:bg-foreground/10 transition-colors flex-shrink-0"
					>
						<LuX className="w-3.5 h-3.5 text-muted-foreground" />
					</button>
				</div>
			)}
		</div>
	);
}
