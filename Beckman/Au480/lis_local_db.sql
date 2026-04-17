-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Apr 14, 2026 at 11:45 AM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `lis_local_db`
--

-- --------------------------------------------------------

--
-- Table structure for table `lis_integration_log`
--

CREATE TABLE `lis_integration_log` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `lab_uid` varchar(50) NOT NULL COMMENT 'Lab UID',
  `analyzer_uid` varchar(50) NOT NULL COMMENT 'Analyser instance UID',
  `session_type` enum('DB','DE','ERROR','ACK','NAK','CONNECT','DISCONNECT') NOT NULL COMMENT 'Event type. DB/DE=session boundary. ACK/NAK=protocol response.',
  `message_code` varchar(10) DEFAULT NULL COMMENT 'AU480 2-char distinction code e.g. D  DH DB DE',
  `sample_id` varchar(100) DEFAULT NULL COMMENT 'Sample barcode if this event relates to a specific sample',
  `details` text DEFAULT NULL COMMENT 'Human-readable event description for the log viewer',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='SpeciGo LIS: Communication session and error event log.';

-- --------------------------------------------------------

--
-- Table structure for table `lis_results`
--

CREATE TABLE `lis_results` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `lab_uid` varchar(50) DEFAULT NULL,
  `analyzer_uid` varchar(50) DEFAULT NULL,
  `barcode_uid` varchar(50) DEFAULT NULL,
  `value` varchar(50) DEFAULT NULL,
  `flag` varchar(20) DEFAULT NULL,
  `unit` varchar(20) DEFAULT NULL,
  `parameter_code` varchar(50) DEFAULT NULL,
  `patient_uid` varchar(50) DEFAULT NULL,
  `patient_name` varchar(100) DEFAULT NULL,
  `age` int(11) DEFAULT NULL,
  `age_type` varchar(10) DEFAULT NULL,
  `gender` varchar(10) DEFAULT NULL,
  `status` varchar(20) DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `lis_integration_log`
--
ALTER TABLE `lis_integration_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_lab_analyzer_time` (`lab_uid`,`analyzer_uid`,`created_at`),
  ADD KEY `idx_session_type` (`session_type`);

--
-- Indexes for table `lis_results`
--
ALTER TABLE `lis_results`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_barcode` (`barcode_uid`),
  ADD KEY `idx_patient` (`patient_uid`),
  ADD KEY `idx_parameter` (`parameter_code`),
  ADD KEY `idx_created` (`created_at`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `lis_integration_log`
--
ALTER TABLE `lis_integration_log`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `lis_results`
--
ALTER TABLE `lis_results`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
