-- One idempotent statement per table, indexes inline: PlanetScale applies DDL
-- outside the transaction (see 0145).
CREATE TABLE IF NOT EXISTS `workbot_proactive_member` (
	`member_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`opted_in` boolean,
	`muted_kinds` json,
	`snoozed_until` timestamp(3),
	`checkpoint` mediumtext,
	`time_zone` varchar(64),
	`last_checked_at` timestamp(3),
	`next_check_at` timestamp(3) NOT NULL DEFAULT (now()),
	`failures` int NOT NULL DEFAULT 0,
	`lease_owner` varchar(64),
	`lease_until` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `workbot_proactive_member_member_id` PRIMARY KEY(`member_id`),
	INDEX `workbot_proactive_member_due` (`next_check_at`),
	INDEX `workbot_proactive_member_org` (`organization_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workbot_proactive_notification` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`outcome` varchar(16) NOT NULL DEFAULT 'pending',
	`channel_id` varchar(64),
	`message_ts` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `workbot_proactive_notification_id` PRIMARY KEY(`id`),
	INDEX `workbot_proactive_notification_member` (`member_id`,`created_at`)
);
