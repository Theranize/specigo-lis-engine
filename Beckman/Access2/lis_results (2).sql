-- phpMyAdmin SQL Dump
-- version 5.2.0
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: May 04, 2026 at 05:15 AM
-- Server version: 10.11.13-MariaDB-0ubuntu0.24.04.1
-- PHP Version: 8.2.29

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `u151751738_theranizeDevh1`
--

-- --------------------------------------------------------

--
-- Table structure for table `lis_results`
--

CREATE TABLE `lis_results` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `lab_uid` varchar(32) NOT NULL,
  `analyzer_uid` varchar(32) NOT NULL,
  `barcode_uid` varchar(32) NOT NULL,
  `parameter_code` varchar(32) NOT NULL,
  `value` varchar(50) DEFAULT NULL,
  `flag` varchar(20) DEFAULT NULL,
  `unit` varchar(20) DEFAULT NULL,
  `patient_uid` varchar(32) DEFAULT NULL,
  `patient_name` varchar(100) DEFAULT NULL,
  `age` smallint(6) DEFAULT NULL,
  `age_type` char(1) DEFAULT NULL,
  `gender` char(1) DEFAULT NULL,
  `status` tinyint(4) DEFAULT 0,
  `received_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `lis_results`
--

INSERT INTO `lis_results` (`id`, `lab_uid`, `analyzer_uid`, `barcode_uid`, `parameter_code`, `value`, `flag`, `unit`, `patient_uid`, `patient_name`, `age`, `age_type`, `gender`, `status`, `received_at`, `created_at`) VALUES
(1, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'CL', '103', 'N', 'mEq/L', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(2, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'K', '4.3', 'N', 'mEq/L', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(3, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'NA', '140', 'N', 'mEq/L', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(4, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'GLB', '3.0', 'N', 'g/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(5, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'UA', '5.2', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(6, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'UREA', '28', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(7, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'TRG', '140', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(8, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'TP', '7.1', 'N', 'g/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(9, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'TBB', '0.9', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(10, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'MG', '2.0', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(11, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'FE', '85', 'N', 'ug/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(12, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'PHO', '3.6', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(13, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'HDL', '48', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(14, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'GLU', '96', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(15, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'GGT', '28', 'N', 'U/L', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(16, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'DBB', '0.3', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(17, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'CRE', '1.0', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(18, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'CKN', '120', 'N', 'U/L', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(19, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'CHOL', '180', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(20, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'CAL', '9.1', 'N', 'mg/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(21, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'AST', '30', 'N', 'U/L', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(22, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'AMY', '78', 'N', 'U/L', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(23, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'ALT', '32', 'N', 'U/L', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(24, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'ALP', '95', 'N', 'U/L', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50'),
(25, '6887129073FDA', '69F2F5719F591', '69F31DD2D1679', 'ALB', '4.2', 'N', 'g/dL', 'PAT1001', 'Rahul Sharma', 32, 'Y', 'M', 0, '2026-04-30 14:50:42', '2026-04-30 14:50:50');

--
-- Indexes for dumped tables
--

--
-- Indexes for table `lis_results`
--
ALTER TABLE `lis_results`
  ADD PRIMARY KEY (`id`,`lab_uid`),
  ADD KEY `idx_lab_barcode` (`lab_uid`,`barcode_uid`),
  ADD KEY `idx_join_mapping` (`analyzer_uid`,`parameter_code`),
  ADD KEY `idx_created_at` (`created_at`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `lis_results`
--
ALTER TABLE `lis_results`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=26;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
